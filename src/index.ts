import { define } from "@opencode/plugin/effect/plugin";
import { Effect } from "effect";
import { DeviceServer } from "./server.js";
import { DeviceTools } from "./tools.js";

// The server half of the device plugin. It makes the per-session device broker over the frozen control RPC, then
// registers the `device` tools that dispatch through it. It drives no device itself: the broker forwards
// every operation to the desktop connection the user attached, and the tools own only schema selection and the
// conversion of a backend result into tool output and content.
export default define({
  id: "demul.device",
  effect: Effect.fn("DevicePlugin.effect")(function* (ctx) {
    const server = yield* DeviceServer.make(ctx);
    yield* DeviceTools.register(ctx, server);
  }),
});
