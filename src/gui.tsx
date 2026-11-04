import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { MenuItem, Panel, Plugin, usePanel } from "@opencode/plugin/gui";
import { DeviceBridge } from "./bridge.js";
import { DeviceIpc } from "./ipc.js";
import { Device } from "./rpc.js";
import { createLatestRequest } from "./latest-request.js";
import {
  contentPoint,
  createViewer,
  sameScreenFrame,
  screenFrame,
  type ScreenFrame,
  type ViewerState,
} from "./viewer.js";
// @ts-expect-error Vite owns CSS side-effect imports in the GUI bundle.
import styles from "./gui.css?inline";

const PANEL_TAB = "device";
const PLATFORMS: readonly Device.Platform[] = ["android", "ios"];

const firstDevice = (devices: readonly Device.DeviceInfo[]) =>
  devices.find((device) => device.ownership !== "owned-by-other" && device.state === "booted") ??
  devices.find((device) => device.ownership !== "owned-by-other" && device.state !== "unavailable");

const deviceLabel = (device: Device.DeviceInfo) =>
  device.platform === "ios" && device.osVersion
    ? `${device.name} (iOS ${device.osVersion})`
    : device.name;

export default Plugin.define({
  setup(ctx) {
    const style = document.createElement("style");
    style.textContent = styles;
    document.head.appendChild(style);
    onCleanup(() => style.remove());
    const bridge = ctx.main(DeviceIpc.Bridge);
    const connections = new Map<
      string,
      {
        scope: DeviceBridge.Scope;
        abort: AbortController;
        ready: Promise<void>;
        connected: boolean;
      }
    >();
    const scopeKey = (scope: DeviceBridge.Scope) =>
      JSON.stringify([scope.serverID, scope.sessionID]);
    const connect = (scope: DeviceBridge.Scope) => {
      const key = scopeKey(scope);
      const current = connections.get(key);
      if (current) return current.ready;
      const abort = new AbortController();
      const ready = bridge
        .connect(scope, { signal: abort.signal })
        .then(() => {
          const current = connections.get(key);
          if (current?.abort === abort) current.connected = true;
        })
        .catch((error) => {
          if (connections.get(key)?.abort === abort) connections.delete(key);
          throw error;
        });
      connections.set(key, { scope, abort, ready, connected: false });
      return ready;
    };

    createEffect(() => {
      const sessions = [...ctx.sessions.list(), ctx.sessions.current()];
      connections.forEach((connection, key) => {
        if (
          sessions.some(
            (session) =>
              session?.id === connection.scope.sessionID &&
              session.server.id === connection.scope.serverID,
          )
        )
          return;
        connections.delete(key);
        connection.abort.abort();
        void bridge.disconnect(connection.scope).catch(() => undefined);
      });
    });

    onCleanup(() => {
      connections.forEach((connection) => {
        connection.abort.abort();
        void bridge.disconnect(connection.scope).catch(() => undefined);
      });
      connections.clear();
    });

    const DevicePanel = (props: {
      readonly sessionID: string;
      readonly serverID: string;
      readonly location: DeviceBridge.Scope["location"];
    }) => {
      const panel = usePanel();
      const [devices, setDevices] = createSignal<readonly Device.DeviceInfo[]>([]);
      const [selectedDevice, setSelectedDevice] = createSignal("");
      const [selectedPlatform, setSelectedPlatform] = createSignal<Device.Platform>("android");
      let platformChosen = false;
      const platformDevices = createMemo(() =>
        devices().filter((device) => device.platform === selectedPlatform()),
      );
      const [opening, setOpening] = createSignal(false);
      const [listing, setListing] = createSignal(false);
      const [error, setError] = createSignal<string>();
      const [connectionError, setConnectionError] = createSignal<string>();
      const [viewerState, setViewerState] = createSignal<ViewerState>("idle");
      const [renderedToken, setRenderedToken] = createSignal<string>();
      const [viewer, setViewer] = createSignal<ReturnType<typeof createViewer>>();
      const [canvas, setCanvas] = createSignal<HTMLCanvasElement>();
      const [viewerRevision, setViewerRevision] = createSignal(0);
      const scope = () => ({
        sessionID: props.sessionID,
        serverID: props.serverID,
        location: props.location,
      });
      const attachment = () =>
        bridge.state()?.find((entry) => scopeKey(entry.scope) === scopeKey(scope()))?.state ??
        undefined;
      const attachmentToken = createMemo(() => attachment()?.handle.token);
      createEffect(() => {
        attachmentToken();
        if (untrack(opening)) return;
        const current = untrack(attachment);
        if (!current) return;
        setSelectedPlatform(current.handle.platform);
        setSelectedDevice(current.selection?.deviceId ?? current.handle.deviceId);
      });
      const discoveryMessage = () => {
        if (listing() && !opening() && !attachment()) return "Finding devices...";
        if (!listing() && !opening() && !attachment() && devices().length === 0)
          return "No emulators or simulators found.";
      };
      const openingMessage = () => {
        if (!opening()) return;
        return devices().find((device) => device.id === selectedDevice())?.state === "shutdown"
          ? "Booting up device..."
          : "Connecting to device...";
      };
      const screenMessage = () => {
        if (
          attachment()?.capabilities.supported.includes("stream") &&
          (viewerState() === "idle" || viewerState() === "connecting")
        ) {
          return "Almost done, preparing the screen...";
        }
      };
      const startupMessage = createMemo(() => {
        if (connectionError() || error()) return;
        return openingMessage() ?? discoveryMessage() ?? screenMessage();
      });
      let pointerStart:
        | { point: Device.LogicalPoint; frame: ScreenFrame; pointerId: number }
        | undefined;
      const displayedFrame = () => {
        const surface = canvas();
        if (!surface) return;
        return screenFrame(attachmentToken(), renderedToken(), viewerState(), surface);
      };

      createEffect(() => {
        const key = scopeKey(scope());
        const present = bridge.state()?.some((entry) => scopeKey(entry.scope) === key);
        const previous = connections.get(key);
        const reconnecting = previous?.connected && !present;
        if (reconnecting) {
          connections.delete(key);
          previous.abort.abort();
        }
        setConnectionError(undefined);
        void connect(scope())
          .then(() => {
            if (reconnecting && scopeKey(scope()) === key) return refresh();
          })
          .catch((error) => {
            if (scopeKey(scope()) === key) setConnectionError(message(error));
          });
      });

      const value = (result: DeviceBridge.Outcome) => {
        if (result.type === "failure")
          throw new Error(`${result.error.code}: ${result.error.message}`);
        return result.value;
      };
      const outcome = async (action: () => Promise<DeviceBridge.Outcome>) => {
        setError(undefined);
        try {
          return value(await action());
        } catch (cause) {
          setError(message(cause));
        }
      };
      const restoreSelection = () => {
        const current = attachment();
        setSelectedDevice(current?.selection?.deviceId ?? current?.handle.deviceId ?? "");
        if (current) setSelectedPlatform(current.handle.platform);
      };
      const selection = createLatestRequest({
        pending: setOpening,
        error(cause) {
          setError(message(cause));
          restoreSelection();
        },
      });
      const discovery = createLatestRequest({
        pending: setListing,
        error: (cause) => setError(message(cause)),
      });
      onCleanup(() => {
        selection.cancel();
        discovery.cancel();
      });

      const refresh = async () => {
        setError(undefined);
        const input = { serverID: props.serverID, sessionID: props.sessionID };
        await discovery.run(
          (signal) => bridge.list(input, { signal }),
          (result) => {
            const listed = value(result);
            if (listed.type !== "devices") return;
            setDevices(listed.devices);
            if (opening()) return;
            if (attachment()) {
              if (viewerState() === "paused") setViewerRevision((revision) => revision + 1);
              return;
            }
            const first =
              firstDevice(platformDevices()) ??
              (!platformChosen && !selectedDevice() ? firstDevice(listed.devices) : undefined);
            if (first) {
              setSelectedPlatform(first.platform);
              void selectDevice(first.id);
            }
          },
        );
      };

      const selectPlatform = async (platform: Device.Platform) => {
        platformChosen = true;
        if (platform === selectedPlatform()) return;
        selection.cancel();
        setSelectedPlatform(platform);
        const first =
          platformDevices().find((device) => device.id === selectedDevice()) ??
          firstDevice(platformDevices());
        if (first) await selectDevice(first.id);
        else setSelectedDevice("");
      };

      const selectDevice = async (id: string) => {
        if (opening() && id === selectedDevice()) return;
        setSelectedDevice(id);
        setError(undefined);
        const target = scope();
        await selection.run(
          async (signal) => {
            const device = devices().find((item) => item.id === id);
            if (!device) throw new Error("The selected device is no longer available.");
            await connect(target);
            signal.throwIfAborted();
            return bridge.manual(
              {
                scope: target,
                operation: {
                  type: "open",
                  platform: device.platform,
                  deviceId: device.id,
                  boot: device.state === "shutdown",
                },
              },
              { signal },
            );
          },
          (result) => {
            if (result.type === "failure" && result.error.code === "detached") restoreSelection();
            else value(result);
          },
        );
      };

      createEffect(() => {
        scope();
        selection.cancel();
        discovery.cancel();
        void refresh();
      });

      createEffect(() => {
        viewerRevision();
        const token = attachmentToken();
        const surface = canvas();
        const current = untrack(attachment);
        pointerStart = undefined;
        setRenderedToken(undefined);
        setViewerState("idle");
        if (surface) {
          surface.width = 0;
          surface.height = 0;
        }
        if (
          !current ||
          current.handle.token !== token ||
          !surface ||
          !current.capabilities.supported.includes("stream")
        )
          return;
        setError(undefined);
        const abort = new AbortController();
        let currentViewer: ReturnType<typeof createViewer> | undefined;
        const isCurrent = () => !abort.signal.aborted && attachmentToken() === token;
        const fail = (cause: unknown) => {
          if (!isCurrent()) return;
          setViewerState("paused");
          setError(message(cause));
        };
        const start = async () => {
          try {
            const result = await bridge.stream(
              { scope: scope(), handle: current.handle },
              { signal: abort.signal },
            );
            if (!isCurrent()) return;
            if (result.type === "failure")
              return fail(`${result.error.code}: ${result.error.message}`);
            currentViewer = createViewer({
              canvas: surface,
              stream: result.stream,
              onState: (state) => {
                if (!isCurrent()) return;
                setRenderedToken(state === "playing" ? token : undefined);
                setViewerState(state);
              },
              onError: fail,
            });
            setViewer(currentViewer);
          } catch (cause) {
            fail(cause);
          }
        };
        void start();
        onCleanup(() => {
          abort.abort();
          currentViewer?.destroy();
          setViewer(undefined);
        });
      });

      createEffect(() => viewer()?.active(panel.visible()));

      const manual = (operation: DeviceBridge.Operation) =>
        outcome(() => bridge.manual({ scope: scope(), operation }));
      const point = (event: PointerEvent) => {
        const surface = canvas();
        if (!surface) return;
        return contentPoint(surface.getBoundingClientRect(), surface, {
          x: event.clientX,
          y: event.clientY,
        });
      };
      const pointerDown = (event: PointerEvent) => {
        pointerStart = undefined;
        const frame = displayedFrame();
        if (event.button !== 0 || !frame) return;
        const start = point(event);
        const surface = canvas();
        if (!start || !surface) return;
        pointerStart = { point: start, frame, pointerId: event.pointerId };
        surface.focus();
        surface.setPointerCapture(event.pointerId);
      };
      const pointerUp = (event: PointerEvent) => {
        const current = attachment();
        const start = pointerStart;
        const from = start?.point;
        const to = point(event);
        pointerStart = undefined;
        const surface = canvas();
        if (
          !current ||
          !start ||
          !from ||
          !to ||
          !surface ||
          start.pointerId !== event.pointerId ||
          !sameScreenFrame(start.frame, displayedFrame())
        )
          return;
        const viewport = { width: surface.width, height: surface.height };
        const distance = Math.hypot(to.x - from.x, to.y - from.y);
        if (distance < 12) {
          void manual({ type: "tap", handle: current.handle, point: to, viewport });
          return;
        }
        void manual({ type: "swipe", handle: current.handle, from, to, viewport });
      };

      return (
        <section class="device-panel" aria-label="Device controls">
          <div class="device-panel__viewer" aria-busy={!!startupMessage()}>
            <canvas
              ref={setCanvas}
              aria-label="Live device screen"
              style={{ visibility: displayedFrame() ? "visible" : "hidden" }}
              tabIndex={0}
              onPointerDown={pointerDown}
              onPointerUp={pointerUp}
              onPointerCancel={() => (pointerStart = undefined)}
            />
            <Show when={startupMessage()}>
              <div
                class="device-panel__viewer-state"
                classList={{ "device-panel__viewer-state--pending": !!displayedFrame() }}
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {startupMessage()}
              </div>
            </Show>
            <Show when={connectionError() || error()}>
              <div class="device-panel__error" role="alert">
                <ctx.ui.Icon name="circle-exclamation" size="small" />
                <span>{error() ?? connectionError()}</span>
              </div>
            </Show>
          </div>

          <footer class="device-panel__picker" aria-label="Device selection">
            <div class="device-panel__platforms" role="group" aria-label="Device platform">
              <For each={PLATFORMS}>
                {(platform) => (
                  <button
                    type="button"
                    class="device-panel__platform"
                    aria-pressed={selectedPlatform() === platform}
                    onClick={() => void selectPlatform(platform)}
                  >
                    {platform === "android" ? "Android" : "iOS"}
                  </button>
                )}
              </For>
            </div>
            <select
              class="device-panel__device-select"
              aria-label="Device"
              value={platformDevices().find((device) => device.id === selectedDevice())?.id ?? ""}
              onChange={(event) => void selectDevice(event.currentTarget.value)}
              disabled={platformDevices().length === 0}
            >
              <option value="" disabled>
                {platformDevices().length ? "Select device" : "No devices"}
              </option>
              <For each={platformDevices()}>
                {(device) => <option value={device.id}>{deviceLabel(device)}</option>}
              </For>
            </select>
            <ctx.ui.Tooltip value="Refresh devices">
              <button
                type="button"
                class="device-panel__action"
                aria-label="Refresh devices"
                aria-busy={listing()}
                onClick={() => void refresh()}
              >
                <ctx.ui.Icon name="refresh" size="small" />
              </button>
            </ctx.ui.Tooltip>
            <ctx.ui.Tooltip
              value={
                attachment()?.agentAccess
                  ? "Revoke agent access for this session"
                  : "Allow agent access for this session"
              }
            >
              <ctx.ui.Switch
                label="Agent device access"
                hideLabel
                checked={attachment()?.agentAccess ?? false}
                disabled={!attachment()}
                onChange={(enabled) =>
                  void outcome(() => bridge.access({ scope: scope(), enabled }))
                }
              />
            </ctx.ui.Tooltip>
          </footer>
        </section>
      );
    };

    ctx.add(MenuItem, {
      menu: "session.panel",
      id: PANEL_TAB,
      title: "Device",
      icon: "monitor",
      run: () => {
        const session = ctx.sessions.current();
        if (session)
          ctx.layout.open(`${ctx.id}:${PANEL_TAB}:${crypto.randomUUID()}`, session, {
            tab: "select",
          });
      },
    });

    ctx.add(Panel, {
      id: PANEL_TAB,
      region: "side",
      wide: true,
      mobile: { title: "Device", order: 40, kind: "menu", icon: "monitor", cached: true },
      list: (input) =>
        input.open
          .filter((id) => id === PANEL_TAB || id.startsWith(`${PANEL_TAB}:`))
          .map((id) => ({ id, title: "Device" })),
      render: (props) => (
        <DevicePanel
          sessionID={props.session.id}
          serverID={props.session.server.id}
          location={props.session.location}
        />
      ),
    });
  },
  main(ctx) {
    return import("./main.js").then((module) => module.default(ctx));
  },
});

function message(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error !== "object" || error === null) return String(error);
  if ("message" in error && typeof error.message === "string") return error.message;
  if ("code" in error && typeof error.code === "string") return error.code;
  return String(error);
}
