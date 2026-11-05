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
import { waitWithSignal } from "./cancellation.js";
import { retryUntilStopped } from "./retry.js";

type ConnectionState =
  | { type: "connecting" | "reporting"; gate: ReturnType<typeof Promise.withResolvers<void>> }
  | { type: "ready" | "closed" };
type Binding =
  | { type: "attached"; owner: DeviceCaller }
  | { type: "releasing"; owner: DeviceCaller; pending: Promise<void> };

interface Connection {
  windows: Set<number>;
  state: ConnectionState;
  reporting: Promise<void>;
  sessionID: string;
  serverID: string;
  location: DeviceBridge.Scope["location"];
  connectionID: string;
  abort: AbortController;
  requests: Map<string, AbortController>;
  stopEvents: () => void;
  proxy?: { token: string; sourceToken: string; pending: Promise<StreamProxy> };
}

export function createMainSetup(
  runtime: () => DeviceRuntime = createNativeRuntime,
  retryDelayMs = 250,
): Plugin.MainSetup {
  return (ctx) => {
    let controller: DeviceController | undefined;
    const connections = new Map<string, Connection>();
    const bindings = new Map<string, Binding>();
    const lifecycle = new AbortController();
    let watching: Promise<void> | undefined;
    const connectionKey = (scope: DeviceCaller) =>
      JSON.stringify([scope.serverID, scope.sessionID]);
    const getController = () => (controller ??= createDeviceController(runtime()));
    const requireLocal = (serverID: string) => {
      lifecycle.signal.throwIfAborted();
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
      if (!connection || connection.state.type !== "ready" || !connection.windows.has(window))
        throw new Error("device.bridge.disconnected");
      return connection;
    };
    const changed = (connection: Connection) =>
      connection.windows.forEach((window) => provider.changed(window));
    const stopProxy = async (connection: Connection) => {
      const proxy = connection.proxy;
      connection.proxy = undefined;
      await proxy?.pending
        .then((value) => value.stop())
        .catch((error) => {
          ctx.log.write("warn", "device stream cleanup failed", { error: String(error) });
        });
    };
    const report = (connection: Connection) => {
      const result = connection.reporting.then(async () => {
        if (connection.state.type === "closed") return;
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
    const disconnect = async (
      connection: Connection,
      error: unknown = new Error("The device connection closed before it was ready."),
    ) => {
      const key = connectionKey(connection);
      if (connection.state.type === "closed" || connections.get(key) !== connection) return;
      const previous = connection.state;
      connection.state = { type: "closed" };
      connections.delete(key);
      if ("gate" in previous) previous.gate.reject(error);
      connection.stopEvents();
      connection.abort.abort();
      connection.requests.forEach((request) => request.abort());
      await stopProxy(connection);
      if (bindings.get(key)?.type === "attached" && !controller?.state(caller(connection)))
        bindings.delete(key);
      changed(connection);
    };
    const releaseBinding = (binding: Binding): Promise<void> => {
      if (binding.type === "releasing") return binding.pending;
      const key = connectionKey(binding.owner);
      const releasing: Extract<Binding, { type: "releasing" }> = {
        type: "releasing",
        owner: binding.owner,
        pending: Promise.resolve().then(() =>
          retryUntilStopped(
            async () => {
              const connection = connections.get(key);
              if (connection) await disconnect(connection);
              await controller?.detach(binding.owner);
              if (bindings.get(key) === releasing) bindings.delete(key);
            },
            lifecycle.signal,
            (error) => {
              ctx.log.write("warn", "device session cleanup failed; retrying", {
                error: String(error),
              });
            },
            retryDelayMs,
          ),
        ),
      };
      bindings.set(key, releasing);
      return releasing.pending;
    };
    const watchSessions = () => {
      watching ??= retryUntilStopped(
        async () => {
          for await (const event of ctx.client.event.subscribe({ signal: lifecycle.signal })) {
            if (lifecycle.signal.aborted) return;
            if (event.type !== "session.deleted" && event.type !== "session.moved") continue;
            for (const binding of bindings.values()) {
              if (binding.owner.sessionID === event.data.sessionID) void releaseBinding(binding);
            }
          }
          if (!lifecycle.signal.aborted) throw new Error("The device session event stream closed.");
        },
        lifecycle.signal,
        (error) => {
          ctx.log.write("warn", "device session events failed; reconnecting", {
            error: String(error),
          });
        },
        retryDelayMs,
      );
    };
    const unsubscribe = async (connection: Connection, window: number) => {
      connection.windows.delete(window);
      provider.changed(window);
      if (connection.windows.size) return;
      await stopProxy(connection);
      if (!controller?.state(caller(connection))) await disconnect(connection);
    };
    const command = async (connection: Connection, requestID: string) => {
      if (connection.state.type === "closed" || connection.requests.has(requestID)) return;
      const request = new AbortController();
      connection.requests.set(requestID, request);
      const signal = AbortSignal.any([connection.abort.signal, request.signal]);
      const rpc = ctx.client.rpc(DeviceBridge.ControlRpc);
      try {
        const outcome = await rpc
          .command(
            { sessionID: connection.sessionID, connectionID: connection.connectionID, requestID },
            {
              signal,
              location: connection.location,
            },
          )
          .then(
            (operation) =>
              runOperation(getController(), caller(connection), operation, "agent", signal),
            (error): DeviceBridge.Outcome => ({ type: "failure", error: failure(error) }),
          );
        if (signal.aborted) return;
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
        if (!signal.aborted) {
          ctx.log.write("warn", "device command failed", { requestID, error: String(error) });
        }
      } finally {
        connection.requests.delete(requestID);
      }
    };
    const readyConnection = async (connection: Connection) => {
      const previous = connection.state;
      if (previous.type !== "connecting") return;
      const reporting: ConnectionState = { type: "reporting", gate: previous.gate };
      connection.state = reporting;
      try {
        await report(connection);
        if (connection.state !== reporting) return;
        connection.state = { type: "ready" };
        previous.gate.resolve();
      } catch (error) {
        await disconnect(connection, error);
      }
    };
    const createConnection = (scope: DeviceBridge.Scope) => {
      const { sessionID, serverID, location } = scope;
      if (bindings.get(connectionKey(scope))?.type === "releasing")
        throw deviceError("detached", "This session is releasing its device attachment.");
      getController();
      watchSessions();
      const connectionID = crypto.randomUUID();
      const abort = new AbortController();
      const connection: Connection = {
        windows: new Set(),
        state: { type: "connecting", gate: Promise.withResolvers<void>() },
        reporting: Promise.resolve(),
        sessionID,
        serverID,
        location,
        connectionID,
        abort,
        requests: new Map(),
        stopEvents: () => undefined,
      };
      connections.set(connectionKey(connection), connection);
      bindings.set(connectionKey(connection), { type: "attached", owner: caller(connection) });
      const rpc = ctx.client.rpc(DeviceBridge.ControlRpc);
      connection.stopEvents = rpc.events.on(
        "control",
        (event) => {
          if (event.data.connectionID !== connectionID || connection.state.type === "closed")
            return;
          if (event.data.type === "attached") {
            void readyConnection(connection).catch((error) => {
              ctx.log.write("warn", "device connection cleanup failed", { error: String(error) });
            });
            return;
          }
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
      void attached
        .then(
          () => disconnect(connection),
          (error) => disconnect(connection, error),
        )
        .catch((error) =>
          ctx.log.write("warn", "device connection cleanup failed", { error: String(error) }),
        );
      return connection;
    };
    const connect = async (scope: DeviceBridge.Scope, window: number, signal: AbortSignal) => {
      signal.throwIfAborted();
      requireLocal(scope.serverID);
      const connection = connections.get(connectionKey(scope)) ?? createConnection(scope);
      connection.windows.add(window);
      try {
        const state = connection.state;
        if ("gate" in state) await waitWithSignal(state.gate.promise, signal);
        signal.throwIfAborted();
        if (connection.state.type !== "ready") throw new Error("device.bridge.disconnected");
        provider.changed(window);
      } catch (error) {
        if (signal.aborted)
          void unsubscribe(connection, window).catch((error) =>
            ctx.log.write("warn", "device connection cleanup failed", { error: String(error) }),
          );
        throw error;
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
            devices: await getController().list(
              input.platform,
              owner,
              AbortSignal.any([lifecycle.signal, ipcCaller.signal]),
            ),
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
          const raw = await getController().stream(
            caller(connection),
            input.handle,
            AbortSignal.any([connection.abort.signal, ipcCaller.signal]),
          );
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
        ).catch((error) =>
          ctx.log.write("warn", "device window cleanup failed", { error: String(error) }),
        );
      }),
    );
    ctx.onCleanup(async () => {
      lifecycle.abort();
      await Promise.all([...connections.values()].map((connection) => disconnect(connection)));
      await watching;
      await Promise.all(
        [...bindings.values()].flatMap((binding) =>
          binding.type === "releasing" ? [binding.pending] : [],
        ),
      );
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
  if (error instanceof Error && error.name === "TimeoutError")
    return {
      code: "timeout" as const,
      message: "The queued device request exceeded its deadline.",
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
