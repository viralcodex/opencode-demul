export * as DeviceServer from "./server.js";

import type { Context } from "@opencode/plugin/effect/plugin";
import type { RpcRegistration } from "@opencode/plugin/effect/rpc";
import { Session } from "@opencode/schema/session";
import { Tool } from "@opencode/schema/tool";
import { Deferred, Effect, Option, Schema, Stream } from "effect";
import { DeviceBridge } from "./bridge.js";

// One desktop connection for a session. The map is keyed by the session ID string the control RPC carries, and keeps
// the decoded `Session.ID` for the session operations. `state` is the last `Attachment` the desktop pushed, or null
// until it opens a device. Each in-flight agent request parks a `Deferred` the desktop later resolves through `result`.
interface Attachment {
  readonly connectionID: string;
  readonly sessionID: Session.ID;
  state: DeviceBridge.Attachment | null;
  readonly closed: Deferred.Deferred<"closed" | "replaced">;
  readonly pending: Map<
    string,
    { operation: DeviceBridge.Operation; result: Deferred.Deferred<DeviceBridge.Value, Tool.Error> }
  >;
}

export type Server = Effect.Success<ReturnType<typeof make>>;

export const make = Effect.fn("DeviceServer.make")(function* (
  ctx: Pick<Context, "rpc" | "session" | "location" | "event">,
) {
  const attachments = new Map<string, Attachment>();
  let active = true;
  // Resolving `closed` unblocks every parked request through its race below, so a detached or replaced connection
  // reports each in-flight action as conservatively unknown rather than silently dropping it.
  const close = (sessionID: string, reason: "closed" | "replaced" = "closed") =>
    Effect.gen(function* () {
      const attachment = attachments.get(sessionID);
      if (!attachment) return;
      attachments.delete(sessionID);
      yield* Deferred.succeed(attachment.closed, reason);
    });
  yield* Effect.addFinalizer(() => {
    active = false;
    return Effect.forEach(attachments.keys(), (id) => close(id), { discard: true });
  });
  const rpc: RpcRegistration<typeof DeviceBridge.ControlRpc> = yield* ctx.rpc
    .register(DeviceBridge.ControlRpc, {
      attach: (input, call) =>
        Effect.gen(function* () {
          const decoded = Schema.decodeUnknownOption(Session.ID)(input.sessionID);
          if (Option.isNone(decoded))
            return yield* Effect.fail(
              call.error("unavailable", "Invalid session id.", {
                code: "not-found",
                message: "Invalid session id.",
                mayHaveExecuted: false,
              }),
            );
          const sessionID = decoded.value;
          const session = yield* ctx.session.get({ sessionID }).pipe(
            Effect.mapError(() =>
              call.error("unavailable", "Session not found.", {
                code: "not-found",
                message: "Session not found.",
                mayHaveExecuted: false,
              }),
            ),
          );
          if (session.location.directory !== ctx.location.directory)
            return yield* Effect.fail(
              call.error("unavailable", "Session belongs to another location.", {
                code: "not-found",
                message: "Session belongs to another location.",
                mayHaveExecuted: false,
              }),
            );
          const attachment = yield* Effect.acquireRelease(
            Effect.gen(function* () {
              if (!active)
                return yield* Effect.fail(
                  call.error("unavailable", "Device server is shutting down.", {
                    code: "internal",
                    message: "Device server is shutting down.",
                    mayHaveExecuted: false,
                  }),
                );
              yield* close(input.sessionID, "replaced");
              const attachment: Attachment = {
                connectionID: input.connectionID,
                sessionID,
                state: null,
                closed: yield* Deferred.make<"closed" | "replaced">(),
                pending: new Map(),
              };
              attachments.set(input.sessionID, attachment);
              return attachment;
            }),
            (attachment) =>
              attachments.get(input.sessionID) === attachment
                ? close(input.sessionID)
                : Effect.void,
          );
          yield* rpc.events
            .emit("control", { type: "attached", connectionID: input.connectionID, version: 1 })
            .pipe(Effect.orDie);
          return yield* Deferred.await(attachment.closed);
        }).pipe(Effect.scoped),
      state: (input, call) =>
        Effect.gen(function* () {
          const attachment = attachments.get(input.sessionID);
          if (!attachment || attachment.connectionID !== input.connectionID)
            return yield* Effect.fail(
              call.error("unavailable", "Device connection is unavailable.", {
                code: "detached",
                message: "Device connection is unavailable.",
                mayHaveExecuted: false,
              }),
            );
          attachment.state = input.state;
        }),
      command: (input, call) =>
        Effect.gen(function* () {
          const attachment = attachments.get(input.sessionID);
          const pending =
            attachment?.connectionID === input.connectionID
              ? attachment.pending.get(input.requestID)
              : undefined;
          if (!pending)
            return yield* Effect.fail(
              call.error("unavailable", "Device request is no longer available.", {
                code: "detached",
                message: "Device request is no longer available.",
                mayHaveExecuted: false,
              }),
            );
          return pending.operation;
        }),
      result: (input, call) =>
        Effect.gen(function* () {
          const attachment = attachments.get(input.sessionID);
          if (!attachment || attachment.connectionID !== input.connectionID)
            return yield* Effect.fail(
              call.error("unavailable", "Device connection is unavailable.", {
                code: "detached",
                message: "Device connection is unavailable.",
                mayHaveExecuted: false,
              }),
            );
          const pending = attachment.pending.get(input.requestID);
          if (!pending) return;
          if (input.outcome.type === "failure")
            return yield* Deferred.fail(
              pending.result,
              new Tool.Error({
                message: `[device.${input.outcome.error.code}] ${input.outcome.error.message}`,
              }),
            ).pipe(Effect.asVoid);
          yield* Deferred.succeed(pending.result, input.outcome.value);
        }).pipe(Effect.asVoid),
    })
    .pipe(Effect.orDie);
  // A deleted or moved session can never reconnect, so its attachment closes and its parked requests report unknown.
  yield* ctx.event.subscribe({ types: ["session.deleted", "session.moved"] }).pipe(
    Stream.runForEach((event) => close(event.data.sessionID)),
    Effect.forkScoped({ startImmediately: true }),
  );

  const forward = Effect.fn("DeviceServer.forward")(function* (
    attachment: Attachment,
    operation: DeviceBridge.Operation,
  ) {
    const requestID = crypto.randomUUID();
    const pending = yield* Deferred.make<DeviceBridge.Value, Tool.Error>();
    attachment.pending.set(requestID, { operation, result: pending });
    return yield* rpc.events
      .emit("control", { type: "command", connectionID: attachment.connectionID, requestID })
      .pipe(
        Effect.mapError(
          (error) =>
            new Tool.Error({
              message: `Could not dispatch device.${operation.type}. Check the desktop connection, then decide whether to retry.`,
              error,
            }),
        ),
        Effect.andThen(Deferred.await(pending)),
        Effect.raceFirst(
          Deferred.await(attachment.closed).pipe(
            Effect.andThen(
              new Tool.Error({
                message:
                  "[device.disconnected] The device connection closed; the action may already have run. Reconnect this session in the desktop app and re-read device state before repeating a mutating action.",
              }),
            ),
          ),
        ),
        Effect.onInterrupt(() =>
          rpc.events
            .emit("control", { type: "cancel", connectionID: attachment.connectionID, requestID })
            .pipe(Effect.ignore),
        ),
        Effect.timeoutOrElse({
          duration: "60 seconds",
          orElse: () =>
            new Tool.Error({
              message: `[device.timeout] device.${operation.type} did not finish within 60 seconds; its outcome is unknown. Check the desktop connection and re-read device state before repeating a mutating action.`,
            }),
        }),
        Effect.ensuring(Effect.sync(() => void attachment.pending.delete(requestID))),
      );
  });

  return {
    state: (sessionID: Session.ID): DeviceBridge.Attachment | null =>
      attachments.get(sessionID)?.state ?? null,
    request: Effect.fn("DeviceServer.request")(function* (
      sessionID: Session.ID,
      operation: DeviceBridge.Operation,
    ) {
      const attachment = attachments.get(sessionID);
      if (!attachment)
        return yield* new Tool.Error({
          message:
            "[device.disconnected] No desktop device connection is attached to this session. Open this session in the desktop app and wait for it to connect, then retry.",
        });
      // State needs no device and no consent: it reports the attachment the desktop last pushed.
      if (operation.type === "state") return { type: "state" as const, state: attachment.state };
      // List enumerates host devices, which needs a connection but not the user's device-access consent.
      if (operation.type === "list") return yield* forward(attachment, operation);
      // Every other operation drives or inspects the attached device, so it requires the user's consent.
      if (!attachment.state?.agentAccess)
        return yield* new Tool.Error({
          message:
            "[device.denied] This session does not have device access. Grant device access to this session in the desktop app, then retry.",
        });
      const device = attachment.state;
      // Open only adopts the device the desktop already attached; the agent never boots or picks a new one.
      if (operation.type === "open") {
        if (
          device.handle.platform !== operation.platform ||
          device.handle.deviceId !== operation.deviceId
        )
          return yield* new Tool.Error({
            message:
              "[device.unavailable] A different device is attached to this session. The agent can only adopt the device already open in the desktop app. Call the state tool to read the attached device.",
          });
        return { type: "attachment" as const, attachment: device };
      }
      // Device-bound operations must target the attached handle, so a stale handle is rejected before dispatch.
      if (
        device.handle.token !== operation.handle.token ||
        device.handle.generation !== operation.handle.generation
      )
        return yield* new Tool.Error({
          message:
            "[device.detached] This device handle no longer matches the attached device. Call the state tool to read the current handle, then retry with it.",
        });
      return yield* forward(attachment, operation);
    }),
  };
});
