export * as DeviceBridge from "./bridge.js";

import { Rpc } from "@opencode/schema/rpc";
import { Schema } from "effect";
import { Device } from "./rpc.js";

const optional = Schema.optional;
const short = Schema.String.check(Schema.isMaxLength(2_048));
const sessionID = short.check(Schema.isMinLength(1));
const connection = { sessionID, connectionID: Schema.String };
const request = { ...connection, requestID: Schema.String };
const dimension = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 1_000_000 }),
);
const viewport = Schema.optional(Schema.Struct({ width: dimension, height: dimension }));

export const Scope = Schema.Struct({
  sessionID,
  serverID: short,
  location: Schema.optionalKey(Schema.Struct({ directory: short })),
});
export type Scope = typeof Scope.Type;

export const Attachment = Schema.Struct({
  handle: Device.DeviceHandle,
  capabilities: Device.Capabilities,
  agentAccess: Schema.Boolean,
}).annotate({ identifier: "DeviceBridge.Attachment" });
export type Attachment = typeof Attachment.Type;

export const Operation = Schema.Union([
  Schema.Struct({ type: Schema.Literal("list"), platform: optional(Device.Platform) }),
  Schema.Struct({ type: Schema.Literal("state") }),
  Schema.Struct({
    type: Schema.Literal("open"),
    platform: Device.Platform,
    deviceId: short,
    boot: optional(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("apps"), handle: Device.DeviceHandle }),
  Schema.Struct({
    type: Schema.Literal("launch"),
    handle: Device.DeviceHandle,
    app: short,
    deepLink: optional(short),
    relaunch: optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("install"),
    handle: Device.DeviceHandle,
    artifactPath: short,
  }),
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    handle: Device.DeviceHandle,
    interactiveOnly: optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("press"),
    handle: Device.DeviceHandle,
    reference: Device.SnapshotReference,
  }),
  Schema.Struct({
    type: Schema.Literal("tap"),
    handle: Device.DeviceHandle,
    point: Device.LogicalPoint,
    viewport,
  }),
  Schema.Struct({
    type: Schema.Literal("fill"),
    handle: Device.DeviceHandle,
    reference: Device.SnapshotReference,
    text: short,
  }),
  Schema.Struct({
    type: Schema.Literal("swipe"),
    handle: Device.DeviceHandle,
    from: Device.LogicalPoint,
    to: Device.LogicalPoint,
    viewport,
  }),
  Schema.Struct({
    type: Schema.Literal("key"),
    handle: Device.DeviceHandle,
    key: Device.NavigationKey,
  }),
  Schema.Struct({ type: Schema.Literal("screenshot"), handle: Device.DeviceHandle }),
  Schema.Struct({
    type: Schema.Literal("close"),
    handle: Device.DeviceHandle,
    shutdown: optional(Schema.Boolean),
  }),
])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "DeviceBridge.Operation" });
export type Operation = typeof Operation.Type;

export const Value = Schema.Union([
  Schema.Struct({ type: Schema.Literal("devices"), devices: Schema.Array(Device.DeviceInfo) }),
  Schema.Struct({ type: Schema.Literal("state"), state: Schema.NullOr(Attachment) }),
  Schema.Struct({ type: Schema.Literal("attachment"), attachment: Attachment }),
  Schema.Struct({ type: Schema.Literal("apps"), apps: Schema.Array(Device.AppInfo) }),
  Schema.Struct({ type: Schema.Literal("launch"), result: Device.LaunchResult }),
  Schema.Struct({ type: Schema.Literal("install"), result: Device.InstallResult }),
  Schema.Struct({ type: Schema.Literal("snapshot"), snapshot: Device.Snapshot }),
  Schema.Struct({ type: Schema.Literal("screenshot"), screenshot: Device.Screenshot }),
  Schema.Struct({ type: Schema.Literal("done") }),
])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "DeviceBridge.Value" });
export type Value = typeof Value.Type;

export const Outcome = Schema.Union([
  Schema.Struct({ type: Schema.Literal("success"), value: Value }),
  Schema.Struct({ type: Schema.Literal("failure"), error: Device.DeviceError }),
])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "DeviceBridge.Outcome" });
export type Outcome = typeof Outcome.Type;

export const StreamOutcome = Schema.Union([
  Schema.Struct({ type: Schema.Literal("success"), stream: Device.StreamDescriptor }),
  Schema.Struct({ type: Schema.Literal("failure"), error: Device.DeviceError }),
])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "DeviceBridge.StreamOutcome" });
export type StreamOutcome = typeof StreamOutcome.Type;

export const Control = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("attached"),
    connectionID: Schema.String,
    version: Schema.Literal(1),
  }),
  Schema.Struct({
    type: Schema.Literal("command"),
    connectionID: Schema.String,
    requestID: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("cancel"),
    connectionID: Schema.String,
    requestID: Schema.String,
  }),
])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "DeviceBridge.Control" });
export type Control = typeof Control.Type;

const standard = Schema.toStandardSchemaV1;
const errors = { unavailable: standard(Device.DeviceError) };

export const ControlRpc = Rpc.define({
  id: "device.control",
  methods: {
    attach: {
      input: standard(Schema.Struct({ ...connection, version: Schema.Literal(1) })),
      output: standard(Schema.Literals(["closed", "replaced"])),
      errors,
    },
    state: {
      input: standard(Schema.Struct({ ...connection, state: Schema.NullOr(Attachment) })),
      output: standard(Schema.Void),
      errors,
    },
    command: { input: standard(Schema.Struct(request)), output: standard(Operation), errors },
    result: {
      input: standard(Schema.Struct({ ...request, outcome: Outcome })),
      output: standard(Schema.Void),
      errors,
    },
  },
  events: { control: { schema: standard(Control) } },
} satisfies Rpc.PortableDefinition);
