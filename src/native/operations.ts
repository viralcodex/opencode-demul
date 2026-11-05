import { lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Device } from "../rpc.js";
import {
  appsArgs,
  fillArgs,
  installArgs,
  keyArgs,
  launchArgs,
  parseApps,
  parseSnapshotJson,
  pressArgs,
  screenshotArgs,
  snapshotArgs,
  swipeArgs,
  tapArgs,
  type Automation,
} from "./automation.js";
import { cancellationError, deviceError, isDeviceFailure } from "./errors.js";
import type { HandleRegistry } from "./handle.js";
import type { HubConnection } from "./hub-connection.js";
import type { PlatformBackend } from "./backends.js";
import { readPngDimensions } from "./png.js";
import type { DeviceRuntime } from "./runtime.js";

export interface ActiveDevice {
  handle: Device.DeviceHandle;
  backend: PlatformBackend;
  hub: HubConnection;
  automation: Automation;
  stateDir: string;
  capabilities: Device.Capabilities;
}

type Operations = Omit<DeviceRuntime, "list" | "open" | "close" | "dispose">;

export function createDeviceOperations(
  attachment: (handle: Device.DeviceHandle, capability?: Device.Capability) => ActiveDevice,
  registry: HandleRegistry,
): Operations {
  const mutate = async <Value>(
    handle: Device.DeviceHandle,
    signal: AbortSignal | undefined,
    action: () => Promise<Value>,
  ): Promise<Value> => {
    signal?.throwIfAborted();
    registry.invalidate(handle);
    try {
      const value = await action();
      signal?.throwIfAborted();
      return value;
    } catch (error) {
      throw mutationFailure(error, signal);
    }
  };

  const command = async (
    found: ActiveDevice,
    args: string[],
    action: string,
    signal?: AbortSignal,
    mutation = false,
  ) => {
    const result = await found.automation.run(args, undefined, signal);
    signal?.throwIfAborted();
    return found.automation.require(result, action, mutation);
  };

  return {
    async apps(handle, signal) {
      const found = attachment(handle, "apps");
      const result = await command(found, appsArgs(), "Listing apps", signal);
      const apps = parseApps(result.stdout);
      if (!apps) throw deviceError("helper-failed", "The app listing could not be read.");
      return apps;
    },

    async launch(input, signal) {
      const found = attachment(input.handle, "launch");
      return mutate(input.handle, signal, async () => {
        await command(
          found,
          launchArgs(input.app, input.deepLink, input.relaunch),
          "Launching the app",
          signal,
          true,
        );
        return { app: input.app, state: "launched" as const };
      });
    },

    async install(input, signal) {
      const found = attachment(input.handle, "install");
      return mutate(input.handle, signal, async () => {
        await command(
          found,
          installArgs(input.artifactPath),
          "Installing the artifact",
          signal,
          true,
        );
        return { installed: true };
      });
    },

    async snapshot(input, signal) {
      const found = attachment(input.handle, "snapshot");
      signal?.throwIfAborted();
      // The helper may replace its ref table even when snapshot output is unreadable or cancelled.
      const revision = registry.nextSnapshot(input.handle);
      const interactiveOnly = input.interactiveOnly ?? true;
      const result = await command(
        found,
        snapshotArgs(interactiveOnly),
        "Taking a snapshot",
        signal,
      );
      const parsed = parseSnapshotJson(result.stdout);
      if (!parsed) throw deviceError("helper-failed", "The snapshot could not be read.");
      return {
        token: input.handle.token,
        generation: input.handle.generation,
        revision,
        interactiveOnly,
        ...parsed,
      };
    },

    async press(input, signal) {
      const found = attachment(input.handle, "press");
      const ref = registry.resolveReference(input.reference, input.handle);
      await mutate(input.handle, signal, () =>
        command(found, pressArgs(ref), "Pressing the element", signal, true),
      );
    },

    async tap(input, signal) {
      const found = attachment(input.handle, input.viewport ? "stream" : "press");
      if (!input.viewport) {
        await mutate(input.handle, signal, () =>
          command(found, tapArgs(input.point), "Tapping the point", signal, true),
        );
        return;
      }
      const stream = await found.hub.descriptor(signal);
      const point = {
        x: input.point.x / input.viewport.width,
        y: input.point.y / input.viewport.height,
      };
      await mutate(input.handle, signal, () => found.backend.tap(stream, point, signal));
    },

    async fill(input, signal) {
      const found = attachment(input.handle, "fill");
      const ref = registry.resolveReference(input.reference, input.handle);
      await mutate(input.handle, signal, () =>
        command(found, fillArgs(ref, input.text), "Filling the field", signal, true),
      );
    },

    async swipe(input, signal) {
      const found = attachment(input.handle, input.viewport ? "stream" : "swipe");
      if (!input.viewport) {
        await mutate(input.handle, signal, () =>
          command(found, swipeArgs(input.from, input.to), "Swiping", signal, true),
        );
        return;
      }
      const stream = await found.hub.descriptor(signal);
      const { width, height } = input.viewport;
      await mutate(input.handle, signal, () =>
        found.backend.swipe(
          stream,
          { x: input.from.x / width, y: input.from.y / height },
          { x: input.to.x / width, y: input.to.y / height },
          signal,
        ),
      );
    },

    async key(input, signal) {
      const found = attachment(input.handle, "key");
      const stream = await found.hub.descriptor(signal);
      await mutate(input.handle, signal, async () => {
        if (await found.backend.pressKey(stream, input.key, signal)) return;
        signal?.throwIfAborted();
        await command(found, keyArgs(input.key), "Pressing the key", signal, true);
      });
    },

    async screenshot(handle, signal) {
      const found = attachment(handle, "screenshot");
      const path = join(found.stateDir, `screenshot-${crypto.randomUUID()}.png`);
      try {
        await command(found, screenshotArgs(path), "Capturing a screenshot", signal);
        const data = await screenshotData(path);
        signal?.throwIfAborted();
        const dimensions = readPngDimensions(data);
        if (!dimensions)
          throw deviceError("invalid-artifact", "The screenshot was not a readable PNG.");
        return {
          data,
          ...dimensions,
          deviceId: found.handle.deviceId,
          platform: found.handle.platform,
        };
      } finally {
        await rm(path, { force: true }).catch(() => undefined);
      }
    },

    async stream(handle, signal) {
      return attachment(handle, "stream").hub.descriptor(signal);
    },
  };
}

function mutationFailure(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted)
    return cancellationError(signal, isDeviceFailure(error) ? error.mayHaveExecuted : true);
  if (isDeviceFailure(error)) return error;
  return deviceError("internal", error instanceof Error ? error.message : String(error), true);
}

async function screenshotData(path: string): Promise<Buffer> {
  const file = await lstat(path).catch(() => null);
  if (!file?.isFile())
    throw deviceError("invalid-artifact", "The screenshot helper wrote no readable file.");
  if (file.size > Device.MAX_SCREENSHOT_BYTES)
    throw deviceError("invalid-artifact", "The screenshot exceeded the maximum allowed size.");
  const data = await readFile(path).catch(() => null);
  if (!data) throw deviceError("invalid-artifact", "The screenshot helper wrote no readable file.");
  if (data.byteLength > Device.MAX_SCREENSHOT_BYTES)
    throw deviceError("invalid-artifact", "The screenshot exceeded the maximum allowed size.");
  return data;
}
