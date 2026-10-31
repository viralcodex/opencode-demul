export * as DeviceIpc from "./ipc.js";

import { Ipc } from "@opencode/plugin/gui";
import { Schema } from "effect";
import { DeviceBridge } from "./bridge.js";
import { Device } from "./rpc.js";

const short = Schema.String.check(Schema.isMaxLength(2_048));

export const Bridge = Ipc.define({
  id: "demul.device.bridge.v2",
  state: Schema.Array(
    Schema.Struct({ scope: DeviceBridge.Scope, state: Schema.NullOr(DeviceBridge.Attachment) }),
  ),
  methods: {
    connect: { input: DeviceBridge.Scope },
    disconnect: { input: DeviceBridge.Scope },
    list: {
      input: Schema.Struct({ platform: Schema.optional(Device.Platform), serverID: short }),
      output: DeviceBridge.Outcome,
    },
    access: {
      input: Schema.Struct({ scope: DeviceBridge.Scope, enabled: Schema.Boolean }),
      output: DeviceBridge.Outcome,
    },
    manual: {
      input: Schema.Struct({ scope: DeviceBridge.Scope, operation: DeviceBridge.Operation }),
      output: DeviceBridge.Outcome,
    },
    stream: {
      input: Schema.Struct({ scope: DeviceBridge.Scope, handle: Device.DeviceHandle }),
      output: DeviceBridge.StreamOutcome,
    },
  },
});
