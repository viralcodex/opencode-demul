import type { Plugin } from "@opencode/plugin/gui/main";
import { Schema } from "effect";
import { DeviceBridge } from "./bridge.js";
import { DeviceIpc } from "./ipc.js";
import {
  createDeviceController,
  type DeviceCaller,
  type DeviceController,
  type DeviceOrigin,
} from "./controller.js";
import { deviceError, isDeviceFailure } from "./native/errors.js";
import { createNativeRuntime, type DeviceRuntime } from "./native/runtime.js";
import type { Device } from "./rpc.js";
import { startStreamProxy, type StreamProxy } from "./stream-proxy.js";

interface Connection {
  windows: Set<number>;
  ready: Promise<void>;
  reporting: Promise<void>;
  sessionID: string;
  serverID: string;
  location: DeviceBridge.Scope["location"];
  connectionID: string;
  abort: AbortController;
  requests: Map<string, AbortController>;
  stopEvents: () => void;
  closed: boolean;
  proxy?: { token: string; sourceToken: string; pending: Promise<StreamProxy> };
}

export function createMainSetup(
  runtime: () => DeviceRuntime = createNativeRuntime,
): Plugin.MainSetup {
  return (ctx) => {
    let controller: DeviceController | undefined;
    const connections = new Map<string, Connection>();
    const bindings = new Map<string, DeviceCaller>();
    const lifecycle = new AbortController();
    let watching = false;
    const connectionKey = (scope: DeviceCaller) =>
      JSON.stringify([scope.serverID, scope.sessionID]);
    const getController = () => (controller ??= createDeviceController(runtime()));
    const requireLocal = (serverID: string) => {
      if (!ctx.serverEndpoints.get(serverID)?.sameMachine) {
        throw deviceError(
          "unsupported",
          "Device control requires this desktop app's own local server.",
        );
      }
    };
    const caller = (connection: Connection): DeviceCaller => ({
      serverID: connection.serverID,
      sessionID: connection.sessionID,
    });
    const current = (scope: DeviceBridge.Scope, window: number) => {
      requireLocal(scope.serverID);
      const connection = connections.get(connectionKey(scope));
      if (!connection || connection.closed || !connection.windows.has(window))
        throw new Error("device.bridge.disconnected");
      return connection;
    };
    const changed = (connection: Connection) =>
      connection.windows.forEach((window) => provider.changed(window));
    const stopProxy = async (connection: Connection) => {
      const proxy = connection.proxy;
      connection.proxy = undefined;
      await proxy?.pending.then((value) => value.stop()).catch(() => undefined);
    };
    const report = (connection: Connection) => {
      const result = connection.reporting.then(async () => {
        if (connection.closed) return;
        const state = getController().state(caller(connection));
        if (connection.proxy && connection.proxy.token !== state?.handle.token)
          await stopProxy(connection);
        changed(connection);
        await ctx.client.rpc(DeviceBridge.ControlRpc).state(
          {
            sessionID: connection.sessionID,
            connectionID: connection.connectionID,
            state,
          },
          { signal: connection.abort.signal, location: connection.location },
        );
      });
      connection.reporting = result.catch(() => undefined);
      return result;
    };
    const disconnect = async (connection: Connection, releaseDevice = false) => {
      const key = connectionKey(connection);
      if (connection.closed || connections.get(key) !== connection) return;
      connection.closed = true;
      connections.delete(key);
      connection.stopEvents();
      connection.abort.abort();
      connection.requests.forEach((request) => request.abort());
      await stopProxy(connection);
      if (releaseDevice) await controller?.detach(caller(connection));
      if (!controller?.state(caller(connection))) bindings.delete(key);
      changed(connection);
    };
    const watchSessions = () => {
      if (watching) return;
      watching = true;
      void (async () => {
        for await (const event of ctx.client.event.subscribe({ signal: lifecycle.signal })) {
          if (event.type !== "session.deleted" && event.type !== "session.moved") continue;
          for (const [key, owner] of bindings) {
            if (owner.sessionID !== event.data.sessionID) continue;
            bindings.delete(key);
            const connection = connections.get(key);
            if (connection) await disconnect(connection, true);
            else await controller?.detach(owner);
          }
        }
      })().catch((error) => {
        if (!lifecycle.signal.aborted)
          ctx.log.write("warn", "device session events failed", { error: String(error) });
      });
    };
    const unsubscribe = async (connection: Connection, window: number) => {
      connection.windows.delete(window);
      provider.changed(window);
      if (connection.windows.size) return;
      await stopProxy(connection);
      if (!controller?.state(caller(connection))) await disconnect(connection);
    };
    const command = async (connection: Connection, requestID: string) => {
      if (connection.closed || connection.requests.has(requestID)) return;
      const request = new AbortController();
      connection.requests.set(requestID, request);
      const rpc = ctx.client.rpc(DeviceBridge.ControlRpc);
      try {
        const outcome = await rpc
          .command(
            { sessionID: connection.sessionID, connectionID: connection.connectionID, requestID },
            {
              signal: AbortSignal.any([connection.abort.signal, request.signal]),
              location: connection.location,
            },
          )
          .then(
            (operation) =>
              runOperation(
                getController(),
                caller(connection),
                operation,
                "agent",
                AbortSignal.any([connection.abort.signal, request.signal]),
              ),
            (error): DeviceBridge.Outcome => ({ type: "failure", error: failure(error) }),
          );
        if (connection.closed || request.signal.aborted) return;
        await rpc.result(
          {
            sessionID: connection.sessionID,
            connectionID: connection.connectionID,
            requestID,
            outcome: Schema.encodeSync(DeviceBridge.Outcome)(outcome),
          },
          { signal: connection.abort.signal, location: connection.location },
        );
        await report(connection);
      } catch (error) {
        if (!connection.closed && !request.signal.aborted) {
          ctx.log.write("warn", "device command failed", { requestID, error: String(error) });
        }
      } finally {
        connection.requests.delete(requestID);
      }
    };
    const createConnection = (scope: DeviceBridge.Scope) => {
      const { sessionID, serverID, location } = scope;
      getController();
      watchSessions();
      const connectionID = crypto.randomUUID();
      const abort = new AbortController();
      const ready = Promise.withResolvers<void>();
      const connection: Connection = {
        windows: new Set(),
        ready: ready.promise,
        reporting: Promise.resolve(),
        sessionID,
        serverID,
        location,
        connectionID,
        abort,
        requests: new Map(),
        stopEvents: () => undefined,
        closed: false,
      };
      connection.ready = ready.promise.then(() => report(connection));
      connections.set(connectionKey(connection), connection);
      bindings.set(connectionKey(connection), caller(connection));
      const rpc = ctx.client.rpc(DeviceBridge.ControlRpc);
      connection.stopEvents = rpc.events.on(
        "control",
        (event) => {
          if (event.data.connectionID !== connectionID || connection.closed) return;
          if (event.data.type === "attached") return ready.resolve();
          if (event.data.type === "cancel") {
            connection.requests.get(event.data.requestID)?.abort();
            return;
          }
          void command(connection, event.data.requestID);
        },
        { signal: abort.signal },
      );
      const attached = (async () => {
        for await (const event of ctx.client.event.subscribe({ signal: abort.signal })) {
          if (event.type !== "server.connected") continue;
          return rpc.attach(
            { sessionID, connectionID, version: 1 },
            { signal: abort.signal, location },
          );
        }
        throw new Error("The device event stream closed before it connected.");
      })();
      void attached.then(
        () => {
          ready.reject(new Error("The device connection closed before it was ready."));
          return disconnect(connection);
        },
        (error) => {
          ready.reject(error);
          return disconnect(connection);
        },
      );
      return connection;
    };
    const connect = async (scope: DeviceBridge.Scope, window: number, signal: AbortSignal) => {
      signal.throwIfAborted();
      requireLocal(scope.serverID);
      const connection = connections.get(connectionKey(scope)) ?? createConnection(scope);
      connection.windows.add(window);
      const aborted = Promise.withResolvers<never>();
      const cancelled = () => {
        aborted.reject(signal.reason);
        void unsubscribe(connection, window);
      };
      signal.addEventListener("abort", cancelled, { once: true });
      try {
        if (signal.aborted) cancelled();
        await Promise.race([connection.ready, aborted.promise]);
        signal.throwIfAborted();
        provider.changed(window);
      } finally {
        signal.removeEventListener("abort", cancelled);
      }
    };
    const requireStream = (
      connection: Connection,
      input: { scope: DeviceBridge.Scope; handle: Device.DeviceHandle },
      window: number,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      if (
        current(input.scope, window) !== connection ||
        getController().state(caller(connection))?.handle.token !== input.handle.token
      )
        throw deviceError("detached", "The device stream has changed; reconnect the viewer.");
    };

    const provider = ctx.provide(DeviceIpc.Bridge, {
      state: (window: number) => {
        return [...connections.values()]
          .filter((connection) => connection.windows.has(window))
          .map((connection) => ({
            scope: {
              sessionID: connection.sessionID,
              serverID: connection.serverID,
              location: connection.location,
            },
            state: controller?.state(caller(connection)) ?? null,
          }));
      },
      connect: (input, ipcCaller) => connect(input, ipcCaller.window, ipcCaller.signal),
      disconnect: (input, ipcCaller) => {
        const connection = connections.get(connectionKey(input));
        return connection ? unsubscribe(connection, ipcCaller.window) : Promise.resolve();
      },
      list: async (input, ipcCaller) =>
        deviceOutcome(async () => {
          requireLocal(input.serverID);
          const owner = input.sessionID
            ? { serverID: input.serverID, sessionID: input.sessionID }
            : undefined;
          return {
            type: "devices",
            devices: await getController().list(input.platform, owner, ipcCaller.signal),
          };
        }),
      access: async (input, ipcCaller) => {
        const connection = current(input.scope, ipcCaller.window);
        const outcome = await deviceOutcome(() => ({
          type: "attachment" as const,
          attachment: getController().access(caller(connection), input.enabled),
        }));
        await report(connection).catch(() => undefined);
        return outcome;
      },
      manual: async (input, ipcCaller) => {
        const connection = current(input.scope, ipcCaller.window);
        const outcome = await runOperation(
          getController(),
          caller(connection),
          input.operation,
          "manual",
          AbortSignal.any([connection.abort.signal, ipcCaller.signal]),
        );
        await report(connection).catch(() => undefined);
        return outcome;
      },
      stream: async (input, ipcCaller) => {
        const connection = current(input.scope, ipcCaller.window);
        return deviceStreamOutcome(async () => {
          const raw = await getController().stream(caller(connection), input.handle);
          requireStream(connection, input, ipcCaller.window, ipcCaller.signal);
          if (
            connection.proxy &&
            (connection.proxy.token !== input.handle.token ||
              connection.proxy.sourceToken !== raw.token)
          )
            await stopProxy(connection);
          if (!connection.proxy) {
            const proxy = {
              token: input.handle.token,
              sourceToken: raw.token,
              pending: startStreamProxy(raw),
            };
            connection.proxy = proxy;
            void proxy.pending.catch(() => {
              if (connection.proxy === proxy) connection.proxy = undefined;
            });
          }
          const proxy = connection.proxy;
          const stream = await proxy.pending;
          requireStream(connection, input, ipcCaller.window, ipcCaller.signal);
          if (connection.proxy !== proxy)
            throw deviceError("detached", "The device stream has changed; reconnect the viewer.");
          return stream.descriptor;
        });
      },
    });

    ctx.onCleanup(
      ctx.windows.on("close", (window) => {
        void Promise.all(
          [...connections.values()]
            .filter((connection) => connection.windows.has(window.id))
            .map((connection) => unsubscribe(connection, window.id)),
        );
      }),
    );
    ctx.onCleanup(async () => {
      lifecycle.abort();
      await Promise.all([...connections.values()].map((connection) => disconnect(connection)));
      bindings.clear();
      await controller?.dispose();
    });
  };
}

export async function runOperation(
  controller: DeviceController,
  caller: DeviceCaller,
  operation: DeviceBridge.Operation,
  origin: DeviceOrigin,
  signal?: AbortSignal,
): Promise<DeviceBridge.Outcome> {
  return deviceOutcome(async () => {
    signal?.throwIfAborted();
    switch (operation.type) {
      case "list":
        return {
          type: "devices",
          devices: await controller.list(operation.platform, caller, signal),
        };
      case "state":
        return { type: "state", state: controller.state(caller) };
      case "open":
        return {
          type: "attachment",
          attachment: await controller.open(caller, operation, origin, signal),
        };
      case "close":
        await controller.close(caller, operation, origin, signal);
        return { type: "done" };
      default:
        return controller.run(caller, operation, origin, signal);
    }
  });
}

async function deviceOutcome(
  action: () => DeviceBridge.Value | Promise<DeviceBridge.Value>,
): Promise<DeviceBridge.Outcome> {
  try {
    return { type: "success", value: await action() };
  } catch (error) {
    return { type: "failure", error: failure(error) };
  }
}

async function deviceStreamOutcome(
  action: () => Promise<Device.StreamDescriptor>,
): Promise<DeviceBridge.StreamOutcome> {
  try {
    return { type: "success", stream: await action() };
  } catch (error) {
    return { type: "failure", error: failure(error) };
  }
}

function failure(error: unknown) {
  if (isDeviceFailure(error)) return error.data;
  if (error instanceof Error && error.name === "AbortError")
    return {
      code: "detached" as const,
      message: "The pending device request was cancelled.",
      mayHaveExecuted: false,
    };
  return {
    code: "internal" as const,
    message: String(error).slice(0, 2_048),
    mayHaveExecuted: false,
  };
}

const setup = createMainSetup();
export default setup;
