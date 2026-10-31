import { expect, test } from "bun:test";
import type { Context } from "@opencode/plugin/effect/plugin";
import type { RpcHandlers, RpcRegistration } from "@opencode/plugin/effect/rpc";
import type { Rpc } from "@opencode/schema/rpc";
import { Location } from "@opencode/schema/location";
import { Money } from "@opencode/schema/money";
import { Project } from "@opencode/schema/project";
import { AbsolutePath } from "@opencode/schema/schema";
import { Session } from "@opencode/schema/session";
import { Tool } from "@opencode/schema/tool";
import { DateTime, Effect, Exit, Fiber, Schema, Scope, Stream } from "effect";
import { DeviceBridge } from "./bridge.js";
import { DeviceServer } from "./server.js";

const DIRECTORY = "/project";
const CONNECTION = "connection-a";
const SESSION_ID = "ses_device_server_test";
const HANDLE = {
  token: "dh_11111111-1111-1111-1111-111111111111",
  platform: "ios" as const,
  deviceId: "iphone-15",
  generation: 1,
};

const attachmentWithAccess = Schema.decodeUnknownSync(DeviceBridge.Attachment)({
  handle: HANDLE,
  capabilities: { supported: [], unsupported: [] },
  agentAccess: true,
});
const attachmentWithoutAccess = Schema.decodeUnknownSync(DeviceBridge.Attachment)({
  handle: HANDLE,
  capabilities: { supported: [], unsupported: [] },
  agentAccess: false,
});
const stateOperation = Schema.decodeUnknownSync(DeviceBridge.Operation)({ type: "state" });
const listOperation = Schema.decodeUnknownSync(DeviceBridge.Operation)({ type: "list" });
const openOperation = Schema.decodeUnknownSync(DeviceBridge.Operation)({
  type: "open",
  platform: "ios",
  deviceId: "iphone-15",
});
const openOtherDevice = Schema.decodeUnknownSync(DeviceBridge.Operation)({
  type: "open",
  platform: "ios",
  deviceId: "pixel-9",
});
const snapshotOperation = Schema.decodeUnknownSync(DeviceBridge.Operation)({
  type: "snapshot",
  handle: HANDLE,
});
const staleOperation = Schema.decodeUnknownSync(DeviceBridge.Operation)({
  type: "snapshot",
  handle: { ...HANDLE, generation: 2 },
});
const snapshotValue = Schema.decodeUnknownSync(DeviceBridge.Value)({
  type: "snapshot",
  snapshot: {
    token: HANDLE.token,
    generation: 1,
    revision: 1,
    interactiveOnly: false,
    complete: true,
    nodes: [],
  },
});
const devicesValue = Schema.decodeUnknownSync(DeviceBridge.Value)({ type: "devices", devices: [] });
const snapshotOutcome = Schema.decodeUnknownSync(DeviceBridge.Outcome)({
  type: "success",
  value: snapshotValue,
});
const devicesOutcome = Schema.decodeUnknownSync(DeviceBridge.Outcome)({
  type: "success",
  value: devicesValue,
});
const failureOutcome = Schema.decodeUnknownSync(DeviceBridge.Outcome)({
  type: "failure",
  error: { code: "device-busy", message: "The device is busy.", mayHaveExecuted: false },
});

// The session domain is large, but the device server only reads `get`. Every other method is a filler that fails if a
// future change starts to use it, so the fixture never silently fakes behavior the server did not ask for.
const notUsed = (..._args: ReadonlyArray<unknown>): Effect.Effect<never> =>
  Effect.die("The device server does not use this session domain method.");

const makeSession = (id: string, directory: string): Session.Info =>
  Session.Info.make({
    id: Session.ID.make(id),
    projectID: Project.ID.global,
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
  });

interface Rejection {
  readonly type: string;
  readonly message: string;
  readonly data: unknown;
}

function harness(sessions: ReadonlyArray<Session.Info>) {
  const directory = AbsolutePath.make(DIRECTORY);
  const emitted: Array<DeviceBridge.Control> = [];
  const rejections: Array<Rejection> = [];
  let captured: RpcHandlers<typeof DeviceBridge.ControlRpc> | undefined;

  const register = <const D extends Rpc.Definition>(
    _definition: D,
    handlers: RpcHandlers<D>,
  ): Effect.Effect<RpcRegistration<D>, never, Scope.Scope> => {
    // The device server registers exactly one definition, ControlRpc, so these are its control handlers.
    captured = handlers as unknown as RpcHandlers<typeof DeviceBridge.ControlRpc>;
    const registration: RpcRegistration<D> = {
      dispose: Effect.void,
      // Decoding each payload asserts the server only emits valid control events, and lands them typed for the test.
      events: {
        emit: (...args) =>
          Effect.sync(
            () => void emitted.push(Schema.decodeUnknownSync(DeviceBridge.Control)(args[1])),
          ),
      },
    };
    return Effect.succeed(registration);
  };

  const client = <D extends Rpc.Definition>(_definition: D): never => {
    throw new Error("The device server never calls the RPC client directly.");
  };

  const byID = new Map(sessions.map((session) => [session.id as string, session]));
  const session: Context["session"] = {
    get: (input) => {
      const found = byID.get(input.sessionID);
      if (!found) return Effect.fail("session not found");
      return Effect.succeed(found);
    },
    list: notUsed,
    create: notUsed,
    remove: notUsed,
    switchAgent: notUsed,
    switchModel: notUsed,
    prompt: notUsed,
    generate: notUsed,
    command: notUsed,
    compact: notUsed,
    synthetic: notUsed,
    interrupt: notUsed,
    update: notUsed,
    move: notUsed,
    context: notUsed,
    wait: notUsed,
    instructions: { entry: { list: notUsed, put: notUsed, remove: notUsed } },
    hook: notUsed,
  };

  const ctx: Pick<Context, "rpc" | "session" | "location" | "event"> = {
    rpc: Object.assign(client, { register }),
    session,
    location: Location.Info.make({
      directory,
      project: { id: Project.ID.global, directory, canonical: directory },
    }),
    event: { subscribe: () => Stream.empty },
  };

  // The branded error the real host mints is unconstructable here, so the factory records the rejection and throws,
  // which the server surfaces as a handler failure; the test inspects the recorded call rather than the opaque value.
  const call = {
    error: (...args: ReadonlyArray<unknown>): never => {
      const [type, message, data] = args;
      rejections.push({ type: String(type), message: String(message), data });
      throw new Error(`control rpc rejected: ${String(type)}`);
    },
  };

  return {
    ctx,
    call,
    emitted,
    rejections,
    handlers: () => {
      if (!captured) throw new Error("ControlRpc handlers were not registered.");
      return captured;
    },
  };
}

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect));

const commandRequestID = (emitted: ReadonlyArray<DeviceBridge.Control>) => {
  const command = emitted.find((control) => control.type === "command");
  if (command?.type !== "command") throw new Error("expected a command control event");
  return command.requestID;
};

test("attach registers the connection and announces protocol version 1", async () => {
  const context = harness([makeSession(SESSION_ID, DIRECTORY)]);
  await run(
    Effect.gen(function* () {
      const server = yield* DeviceServer.make(context.ctx);
      const attach = yield* context
        .handlers()
        .attach({ sessionID: SESSION_ID, connectionID: CONNECTION, version: 1 }, context.call)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      expect(context.emitted).toContainEqual({
        type: "attached",
        connectionID: CONNECTION,
        version: 1,
      });
      expect(server.state(Session.ID.make(SESSION_ID))).toBeNull();
      yield* Fiber.interrupt(attach);
    }),
  );
});

test("attach rejects a session that does not exist", async () => {
  const context = harness([]);
  await run(
    Effect.gen(function* () {
      yield* DeviceServer.make(context.ctx);
      const exit = yield* context
        .handlers()
        .attach({ sessionID: "ses_missing", connectionID: CONNECTION, version: 1 }, context.call)
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(context.rejections).toContainEqual({
        type: "unavailable",
        message: "Session not found.",
        data: { code: "not-found", message: "Session not found.", mayHaveExecuted: false },
      });
    }),
  );
});

test("attach rejects a session bound to another location", async () => {
  const context = harness([makeSession(SESSION_ID, "/elsewhere")]);
  await run(
    Effect.gen(function* () {
      yield* DeviceServer.make(context.ctx);
      const exit = yield* context
        .handlers()
        .attach({ sessionID: SESSION_ID, connectionID: CONNECTION, version: 1 }, context.call)
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(context.rejections.at(-1)?.message).toBe("Session belongs to another location.");
    }),
  );
});

test("state updates require the matching connection", async () => {
  const context = harness([makeSession(SESSION_ID, DIRECTORY)]);
  await run(
    Effect.gen(function* () {
      yield* DeviceServer.make(context.ctx);
      const attach = yield* context
        .handlers()
        .attach({ sessionID: SESSION_ID, connectionID: CONNECTION, version: 1 }, context.call)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      const exit = yield* context
        .handlers()
        .state(
          { sessionID: SESSION_ID, connectionID: "connection-b", state: attachmentWithAccess },
          context.call,
        )
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(context.rejections.at(-1)?.type).toBe("unavailable");
      yield* Fiber.interrupt(attach);
    }),
  );
});

test("request reports a disconnected error when no connection is attached", async () => {
  const context = harness([makeSession(SESSION_ID, DIRECTORY)]);
  await run(
    Effect.gen(function* () {
      const server = yield* DeviceServer.make(context.ctx);
      const error = yield* server
        .request(Session.ID.make(SESSION_ID), snapshotOperation)
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(Tool.Error);
      expect(error.message).toContain("[device.disconnected]");
    }),
  );
});

test("the state operation returns the pushed attachment without consent or a device", async () => {
  const context = harness([makeSession(SESSION_ID, DIRECTORY)]);
  await run(
    Effect.gen(function* () {
      const server = yield* DeviceServer.make(context.ctx);
      const attach = yield* context
        .handlers()
        .attach({ sessionID: SESSION_ID, connectionID: CONNECTION, version: 1 }, context.call)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* context
        .handlers()
        .state(
          { sessionID: SESSION_ID, connectionID: CONNECTION, state: attachmentWithoutAccess },
          context.call,
        );
      const value = yield* server.request(Session.ID.make(SESSION_ID), stateOperation);
      expect(value).toEqual({ type: "state", state: attachmentWithoutAccess });
      expect(context.emitted.some((control) => control.type === "command")).toBe(false);
      yield* Fiber.interrupt(attach);
    }),
  );
});

test("list forwards to the desktop without requiring device access", async () => {
  const context = harness([makeSession(SESSION_ID, DIRECTORY)]);
  await run(
    Effect.gen(function* () {
      const server = yield* DeviceServer.make(context.ctx);
      const attach = yield* context
        .handlers()
        .attach({ sessionID: SESSION_ID, connectionID: CONNECTION, version: 1 }, context.call)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* context
        .handlers()
        .state(
          { sessionID: SESSION_ID, connectionID: CONNECTION, state: attachmentWithoutAccess },
          context.call,
        );
      const request = yield* server
        .request(Session.ID.make(SESSION_ID), listOperation)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      const requestID = commandRequestID(context.emitted);
      const operation = yield* context
        .handlers()
        .command({ sessionID: SESSION_ID, connectionID: CONNECTION, requestID }, context.call);
      expect(operation).toEqual(listOperation);
      yield* context
        .handlers()
        .result(
          { sessionID: SESSION_ID, connectionID: CONNECTION, requestID, outcome: devicesOutcome },
          context.call,
        );
      expect(yield* Fiber.join(request)).toEqual(devicesValue);
      yield* Fiber.interrupt(attach);
    }),
  );
});

test("a device-bound operation is denied until the session is granted device access", async () => {
  const context = harness([makeSession(SESSION_ID, DIRECTORY)]);
  await run(
    Effect.gen(function* () {
      const server = yield* DeviceServer.make(context.ctx);
      const attach = yield* context
        .handlers()
        .attach({ sessionID: SESSION_ID, connectionID: CONNECTION, version: 1 }, context.call)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* context
        .handlers()
        .state(
          { sessionID: SESSION_ID, connectionID: CONNECTION, state: attachmentWithoutAccess },
          context.call,
        );
      const error = yield* server
        .request(Session.ID.make(SESSION_ID), snapshotOperation)
        .pipe(Effect.flip);
      expect(error.message).toContain("[device.denied]");
      expect(context.emitted.some((control) => control.type === "command")).toBe(false);
      yield* Fiber.interrupt(attach);
    }),
  );
});

test("open adopts the attached device and rejects a different one", async () => {
  const context = harness([makeSession(SESSION_ID, DIRECTORY)]);
  await run(
    Effect.gen(function* () {
      const server = yield* DeviceServer.make(context.ctx);
      const attach = yield* context
        .handlers()
        .attach({ sessionID: SESSION_ID, connectionID: CONNECTION, version: 1 }, context.call)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* context
        .handlers()
        .state(
          { sessionID: SESSION_ID, connectionID: CONNECTION, state: attachmentWithAccess },
          context.call,
        );
      const adopted = yield* server.request(Session.ID.make(SESSION_ID), openOperation);
      expect(adopted).toEqual({ type: "attachment", attachment: attachmentWithAccess });
      const error = yield* server
        .request(Session.ID.make(SESSION_ID), openOtherDevice)
        .pipe(Effect.flip);
      expect(error.message).toContain("[device.unavailable]");
      expect(context.emitted.some((control) => control.type === "command")).toBe(false);
      yield* Fiber.interrupt(attach);
    }),
  );
});

test("a stale device handle is rejected before dispatch", async () => {
  const context = harness([makeSession(SESSION_ID, DIRECTORY)]);
  await run(
    Effect.gen(function* () {
      const server = yield* DeviceServer.make(context.ctx);
      const attach = yield* context
        .handlers()
        .attach({ sessionID: SESSION_ID, connectionID: CONNECTION, version: 1 }, context.call)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* context
        .handlers()
        .state(
          { sessionID: SESSION_ID, connectionID: CONNECTION, state: attachmentWithAccess },
          context.call,
        );
      const error = yield* server
        .request(Session.ID.make(SESSION_ID), staleOperation)
        .pipe(Effect.flip);
      expect(error.message).toContain("[device.detached]");
      expect(context.emitted.some((control) => control.type === "command")).toBe(false);
      yield* Fiber.interrupt(attach);
    }),
  );
});

test("a forwarded operation resolves with the desktop's successful outcome", async () => {
  const context = harness([makeSession(SESSION_ID, DIRECTORY)]);
  await run(
    Effect.gen(function* () {
      const server = yield* DeviceServer.make(context.ctx);
      const attach = yield* context
        .handlers()
        .attach({ sessionID: SESSION_ID, connectionID: CONNECTION, version: 1 }, context.call)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* context
        .handlers()
        .state(
          { sessionID: SESSION_ID, connectionID: CONNECTION, state: attachmentWithAccess },
          context.call,
        );
      expect(server.state(Session.ID.make(SESSION_ID))).toEqual(attachmentWithAccess);
      const request = yield* server
        .request(Session.ID.make(SESSION_ID), snapshotOperation)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      const requestID = commandRequestID(context.emitted);
      const operation = yield* context
        .handlers()
        .command({ sessionID: SESSION_ID, connectionID: CONNECTION, requestID }, context.call);
      expect(operation).toEqual(snapshotOperation);
      yield* context
        .handlers()
        .result(
          { sessionID: SESSION_ID, connectionID: CONNECTION, requestID, outcome: snapshotOutcome },
          context.call,
        );
      expect(yield* Fiber.join(request)).toEqual(snapshotValue);
      yield* Fiber.interrupt(attach);
    }),
  );
});

test("a failed outcome surfaces the device error as a tool error", async () => {
  const context = harness([makeSession(SESSION_ID, DIRECTORY)]);
  await run(
    Effect.gen(function* () {
      const server = yield* DeviceServer.make(context.ctx);
      const attach = yield* context
        .handlers()
        .attach({ sessionID: SESSION_ID, connectionID: CONNECTION, version: 1 }, context.call)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* context
        .handlers()
        .state(
          { sessionID: SESSION_ID, connectionID: CONNECTION, state: attachmentWithAccess },
          context.call,
        );
      const request = yield* server
        .request(Session.ID.make(SESSION_ID), snapshotOperation)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      const requestID = commandRequestID(context.emitted);
      yield* context
        .handlers()
        .result(
          { sessionID: SESSION_ID, connectionID: CONNECTION, requestID, outcome: failureOutcome },
          context.call,
        );
      const error = yield* Fiber.join(request).pipe(Effect.flip);
      expect(error).toBeInstanceOf(Tool.Error);
      expect(error.message).toContain("[device.device-busy] The device is busy.");
      yield* Fiber.interrupt(attach);
    }),
  );
});

test("replacing a connection cancels its in-flight request conservatively", async () => {
  const context = harness([makeSession(SESSION_ID, DIRECTORY)]);
  await run(
    Effect.gen(function* () {
      const server = yield* DeviceServer.make(context.ctx);
      const first = yield* context
        .handlers()
        .attach({ sessionID: SESSION_ID, connectionID: CONNECTION, version: 1 }, context.call)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* context
        .handlers()
        .state(
          { sessionID: SESSION_ID, connectionID: CONNECTION, state: attachmentWithAccess },
          context.call,
        );
      const request = yield* server
        .request(Session.ID.make(SESSION_ID), snapshotOperation)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      const second = yield* context
        .handlers()
        .attach({ sessionID: SESSION_ID, connectionID: "connection-b", version: 1 }, context.call)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      const error = yield* Fiber.join(request).pipe(Effect.flip);
      expect(error.message).toContain("[device.disconnected]");
      yield* Fiber.interrupt(first);
      yield* Fiber.interrupt(second);
    }),
  );
});

test("interrupting a request cancels it on the desktop and does not replay", async () => {
  const context = harness([makeSession(SESSION_ID, DIRECTORY)]);
  await run(
    Effect.gen(function* () {
      const server = yield* DeviceServer.make(context.ctx);
      const attach = yield* context
        .handlers()
        .attach({ sessionID: SESSION_ID, connectionID: CONNECTION, version: 1 }, context.call)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* context
        .handlers()
        .state(
          { sessionID: SESSION_ID, connectionID: CONNECTION, state: attachmentWithAccess },
          context.call,
        );
      const request = yield* server
        .request(Session.ID.make(SESSION_ID), snapshotOperation)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      const requestID = commandRequestID(context.emitted);
      yield* Fiber.interrupt(request);
      expect(context.emitted).toContainEqual({
        type: "cancel",
        connectionID: CONNECTION,
        requestID,
      });
      // The request is gone, so a late result for it cannot land a second time.
      const exit = yield* context
        .handlers()
        .command({ sessionID: SESSION_ID, connectionID: CONNECTION, requestID }, context.call)
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(context.rejections.at(-1)?.type).toBe("unavailable");
      yield* Fiber.interrupt(attach);
    }),
  );
});
