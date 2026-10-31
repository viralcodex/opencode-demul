export * as Device from "./rpc.js";

import { Schema } from "effect";

// The upper bound for a screenshot's PNG payload, so a single tool result never streams an unbounded image.
export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

const optional = Schema.optional;
const short = Schema.String.check(Schema.isMaxLength(2_048));
const text = Schema.String.check(Schema.isMaxLength(100_000));
const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
// A logical viewport coordinate: the displayed device surface, not an arbitrary canvas pixel.
const coordinate = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }));

export const Platform = Schema.Literals(["ios", "android"]).annotate({
  identifier: "Device.Platform",
});
export type Platform = typeof Platform.Type;

// A device's boot state as discovery reports it. `unavailable` means the host cannot attach it right now.
export const DeviceState = Schema.Literals([
  "shutdown",
  "booting",
  "booted",
  "unavailable",
]).annotate({
  identifier: "Device.DeviceState",
});
export type DeviceState = typeof DeviceState.Type;

export const Ownership = Schema.Literals([
  "available",
  "owned-by-this-host",
  "owned-by-other",
  "unknown",
]).annotate({
  identifier: "Device.Ownership",
});
export type Ownership = typeof Ownership.Type;

// The device-bound operations the runtime can perform. A capability is advertised only when the backend supports it.
export const Capability = Schema.Literals([
  "apps",
  "launch",
  "install",
  "snapshot",
  "press",
  "fill",
  "swipe",
  "key",
  "screenshot",
  "stream",
]).annotate({ identifier: "Device.Capability" });
export type Capability = typeof Capability.Type;

export const NavigationKey = Schema.Literals([
  "home",
  "back",
  "recents",
  "lock",
  "volumeUp",
  "volumeDown",
]).annotate({
  identifier: "Device.NavigationKey",
});
export type NavigationKey = typeof NavigationKey.Type;

// The connection generation: a monotonic counter the runtime bumps on every attach, so stale handles are rejectable.
export const Generation = count.annotate({ identifier: "Device.Generation" });

export const HandleToken = Schema.String.check(Schema.isPattern(/^dh_[a-f0-9-]{36}$/u))
  .pipe(Schema.brand("Device.HandleToken"))
  .annotate({ identifier: "Device.HandleToken" });
export type HandleToken = typeof HandleToken.Type;

// The handle returned by `open`. It binds a token to one platform, device, and connection generation. Every
// device-bound operation requires it, and the runtime checks the token and generation before dispatching.
export interface DeviceHandle extends Schema.Schema.Type<typeof DeviceHandle> {}
export const DeviceHandle = Schema.Struct({
  token: HandleToken,
  platform: Platform,
  deviceId: short,
  generation: Generation,
}).annotate({ identifier: "Device.DeviceHandle" });

// An element reference, in the automation engine's own `@e<n>` form. References are valid only within one revision.
export const ElementRef = Schema.String.check(Schema.isPattern(/^@?e[1-9][0-9]*$/u))
  .pipe(Schema.brand("Device.ElementRef"))
  .annotate({ identifier: "Device.ElementRef" });
export type ElementRef = typeof ElementRef.Type;

// A reference scoped to the handle and the snapshot revision it came from. The runtime rejects a reference whose token,
// generation, or revision no longer matches the attachment, so a newer snapshot, relaunch, or reconnect invalidates it.
export interface SnapshotReference extends Schema.Schema.Type<typeof SnapshotReference> {}
export const SnapshotReference = Schema.Struct({
  token: HandleToken,
  generation: Generation,
  revision: count,
  ref: ElementRef,
}).annotate({ identifier: "Device.SnapshotReference" });

// One node of an accessibility snapshot. Content is untrusted data, not instructions; absent fields are omitted.
export interface AccessibilityNode extends Schema.Schema.Type<typeof AccessibilityNode> {}
export const AccessibilityNode = Schema.Struct({
  ref: optional(ElementRef),
  role: short,
  name: optional(text),
  value: optional(text),
  enabled: optional(Schema.Boolean),
  focused: optional(Schema.Boolean),
}).annotate({ identifier: "Device.AccessibilityNode" });

// An accessibility snapshot bound to a handle and revision. `complete` is false when the backend returned partial
// accessibility data, so a caller reads the gap honestly rather than treating absent nodes as absent elements.
export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}
export const Snapshot = Schema.Struct({
  token: HandleToken,
  generation: Generation,
  revision: count,
  interactiveOnly: Schema.Boolean,
  complete: Schema.Boolean,
  nodes: Schema.Array(AccessibilityNode),
}).annotate({ identifier: "Device.Snapshot" });

// A logical viewport point. Tools and manual controls share this convention; it is not a raw canvas pixel.
export interface LogicalPoint extends Schema.Schema.Type<typeof LogicalPoint> {}
export const LogicalPoint = Schema.Struct({ x: coordinate, y: coordinate }).annotate({
  identifier: "Device.LogicalPoint",
});

// A device as discovery reports it. `id` is the stable discovery identifier `open` takes; it does not boot anything.
export interface DeviceInfo extends Schema.Schema.Type<typeof DeviceInfo> {}
export const DeviceInfo = Schema.Struct({
  id: short,
  name: short,
  platform: Platform,
  osVersion: optional(short),
  state: DeviceState,
  ownership: Ownership,
}).annotate({ identifier: "Device.DeviceInfo" });

export interface Capabilities extends Schema.Schema.Type<typeof Capabilities> {}
export const Capabilities = Schema.Struct({
  supported: Schema.Array(Capability),
  unsupported: Schema.Array(Schema.Struct({ capability: Capability, reason: short })),
}).annotate({ identifier: "Device.Capabilities" });

// An installed application identity. `name` is present only where the backend reports a label.
export interface AppInfo extends Schema.Schema.Type<typeof AppInfo> {}
export const AppInfo = Schema.Struct({ id: short, name: optional(short) }).annotate({
  identifier: "Device.AppInfo",
});

export interface LaunchResult extends Schema.Schema.Type<typeof LaunchResult> {}
export const LaunchResult = Schema.Struct({
  app: short,
  state: Schema.Literals(["launched", "foreground", "unknown"]),
}).annotate({ identifier: "Device.LaunchResult" });

export interface InstallResult extends Schema.Schema.Type<typeof InstallResult> {}
export const InstallResult = Schema.Struct({
  installed: Schema.Boolean,
  app: optional(short),
}).annotate({
  identifier: "Device.InstallResult",
});

// A screenshot as PNG bytes, with its real dimensions and device identity. The bytes carry the image; a filesystem
// path alone is not a result, so the model inspects the same frame the viewer shows.
export interface Screenshot extends Schema.Schema.Type<typeof Screenshot> {}
export const Screenshot = Schema.Struct({
  data: Schema.Uint8ArrayFromBase64.check(Schema.isMaxLength(MAX_SCREENSHOT_BYTES)),
  width: count,
  height: count,
  deviceId: short,
  platform: Platform,
}).annotate({ identifier: "Device.Screenshot" });

// The stream wire protocol each backend speaks. iOS and Android differ; the viewer decodes the advertised one.
export const StreamProtocol = Schema.Literals(["mjpeg", "h264"]).annotate({
  identifier: "Device.StreamProtocol",
});
export type StreamProtocol = typeof StreamProtocol.Type;

// How to reach the live stream of an attached device. The hub binds to loopback, so `baseUrl` is always a localhost
// origin and `loopback` is always true. The token authenticates the plugin-owned transport and stays in memory; it is
// never persisted, logged, or emitted on a global event, and it is revoked when the attachment ends.
export interface StreamDescriptor extends Schema.Schema.Type<typeof StreamDescriptor> {}
export const StreamDescriptor = Schema.Struct({
  platform: Platform,
  deviceId: short,
  baseUrl: short,
  token: short,
  protocol: StreamProtocol,
  loopback: Schema.Literal(true),
}).annotate({ identifier: "Device.StreamDescriptor" });

export const DeviceErrorCode = Schema.Literals([
  "missing-prerequisite",
  "permission-denied",
  "device-busy",
  "detached",
  "stale-reference",
  "unsupported",
  "not-found",
  "invalid-artifact",
  "timeout",
  "helper-failed",
  "internal",
]).annotate({ identifier: "Device.DeviceErrorCode" });
export type DeviceErrorCode = typeof DeviceErrorCode.Type;

// A structured device error. `mayHaveExecuted` is true when a mutating native action was already dispatched before the
// failure, so a caller never reports a possibly-applied action as cleanly cancelled.
export interface DeviceError extends Schema.Schema.Type<typeof DeviceError> {}
export const DeviceError = Schema.Struct({
  code: DeviceErrorCode,
  message: short,
  mayHaveExecuted: Schema.Boolean,
}).annotate({ identifier: "Device.DeviceError" });
