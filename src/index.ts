import { define } from "@opencode/plugin/effect/plugin";
import { Effect } from "effect";
import { DeviceServer } from "./server.js";
import { DeviceTools } from "./tools.js";

// Register tools and the session broker. Device operations run only in the desktop connection the user attached.
export default define({
  id: "demul.device",
  effect: Effect.fn("DevicePlugin.effect")(function* (ctx) {
    const server = yield* DeviceServer.make(ctx);
    yield* DeviceTools.register(ctx, server);
  }),
});
