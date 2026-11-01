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
  window: number;
  sessionID: string;
  serverID: string;
  location: DeviceBridge.Scope["location"];
  connectionID: string;
  abort: AbortController;
  requests: Map<string, AbortController>;
  seen: Set<string>;
  cancelled: Set<string>;
  stopEvents: () => void;
  closed: boolean;
  proxy?: Promise<StreamProxy>;
}

export function createMainSetup(
  runtime: () => DeviceRuntime = createNativeRuntime,
): Plugin.MainSetup {
  return (ctx) => {
    let controller: DeviceController | undefined;
    const connections = new Map<string, Connection>();
    const connectionKey = (scope: DeviceBridge.Scope, window: number) =>
      JSON.stringify([window, scope.serverID, scope.sessionID]);
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
      serverID: connection.connectionID,
      sessionID: connection.sessionID,
    });
    const current = (scope: DeviceBridge.Scope, window: number) => {
      requireLocal(scope.serverID);
      const connection = connections.get(connectionKey(scope, window));
      if (!connection || connection.closed) throw new Error("device.bridge.disconnected");
      return connection;
    };
    const report = async (connection: Connection) => {
      if (connection.closed) return;
      if (!getController().state(caller(connection)) && connection.proxy) {
        await (await connection.proxy).stop();
        connection.proxy = undefined;
      }
      provider.changed(connection.window);
      await ctx.client.rpc(DeviceBridge.ControlRpc).state(
        {
          sessionID: connection.sessionID,
          connectionID: connection.connectionID,
          state: getController().state(caller(connection)),
        },
        { signal: connection.abort.signal, location: connection.location },
      );
    };
    const disconnect = async (connection: Connection) => {
      const key = connectionKey(connection, connection.window);
      if (connection.closed || connections.get(key) !== connection) return;
      connection.closed = true;
      connections.delete(key);
      connection.stopEvents();
      connection.abort.abort();
      connection.requests.forEach((request) => request.abort());
      if (connection.proxy)
        await connection.proxy.then((proxy) => proxy.stop()).catch(() => undefined);
      const state = controller?.state(caller(connection));
      if (state) {
        await controller
          ?.close(caller(connection), { handle: state.handle }, "manual")
          .catch(() => undefined);
      }
      provider.changed(connection.window);
    };
    const command = async (connection: Connection, requestID: string) => {
      if (
        connection.closed ||
        connection.seen.has(requestID) ||
        connection.cancelled.has(requestID)
      )
        return;
      connection.seen.add(requestID);
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
    const connect = async (
      sessionID: string,
      serverID: string,
      window: number,
      signal: AbortSignal,
      location: DeviceBridge.Scope["location"],
    ) => {
      signal.throwIfAborted();
      requireLocal(serverID);
      const previous = connections.get(connectionKey({ sessionID, serverID }, window));
      if (previous) await disconnect(previous);
      signal.throwIfAborted();
      getController();
      const connectionID = crypto.randomUUID();
      const abort = new AbortController();
      const ready = Promise.withResolvers<void>();
      const connection: Connection = {
        window,
        sessionID,
        serverID,
        location,
        connectionID,
        abort,
        requests: new Map(),
        seen: new Set(),
        cancelled: new Set(),
        stopEvents: () => undefined,
        closed: false,
      };
      connections.set(connectionKey(connection, window), connection);
      const rpc = ctx.client.rpc(DeviceBridge.ControlRpc);
      connection.stopEvents = rpc.events.on(
        "control",
        (event) => {
          if (event.data.connectionID !== connectionID || connection.closed) return;
          if (event.data.type === "attached") return ready.resolve();
          if (event.data.type === "cancel") {
            connection.cancelled.add(event.data.requestID);
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
      const cancelled = () => {
        ready.reject(signal.reason);
        void disconnect(connection);
      };
      signal.addEventListener("abort", cancelled, { once: true });
      try {
        await ready.promise;
        await report(connection);
      } finally {
        signal.removeEventListener("abort", cancelled);
      }
    };

    const provider = ctx.provide(DeviceIpc.Bridge, {
      state: (window: number) => {
        return [...connections.values()]
          .filter((connection) => connection.window === window)
          .map((connection) => ({
            scope: {
              sessionID: connection.sessionID,
              serverID: connection.serverID,
              location: connection.location,
            },
            state: controller?.state(caller(connection)) ?? null,
          }));
      },
      connect: (input, ipcCaller) =>
        connect(
          input.sessionID,
          input.serverID,
          ipcCaller.window,
          ipcCaller.signal,
          input.location,
        ),
      disconnect: (input, ipcCaller) => {
        const connection = connections.get(connectionKey(input, ipcCaller.window));
        return connection ? disconnect(connection) : Promise.resolve();
      },
      list: async (input) =>
        deviceOutcome(async () => {
          requireLocal(input.serverID);
          return { type: "devices", devices: await getController().list(input.platform) };
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
          ipcCaller.signal,
        );
        await report(connection).catch(() => undefined);
        return outcome;
      },
      stream: async (input, ipcCaller) => {
        const connection = current(input.scope, ipcCaller.window);
        return deviceStreamOutcome(async () => {
          const raw = await getController().stream(caller(connection), input.handle);
          ipcCaller.signal.throwIfAborted();
          if (connection.closed) throw new Error("device.bridge.disconnected");
          connection.proxy ??= startStreamProxy(raw).catch((error) => {
            connection.proxy = undefined;
            throw error;
          });
          return (await connection.proxy).descriptor;
        });
      },
    });

    ctx.onCleanup(
      ctx.windows.on("close", (window) => {
        void Promise.all(
          [...connections.values()]
            .filter((connection) => connection.window === window.id)
            .map(disconnect),
        );
      }),
    );
    ctx.onCleanup(async () => {
      await Promise.all([...connections.values()].map(disconnect));
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
        return { type: "devices", devices: await controller.list(operation.platform) };
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
  return {
    code: "internal" as const,
    message: String(error).slice(0, 2_048),
    mayHaveExecuted: false,
  };
}

const setup = createMainSetup();
export default setup;
