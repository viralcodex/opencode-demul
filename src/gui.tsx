import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { MenuItem, Panel, Plugin, usePanel } from "@opencode/plugin/gui";
import { DeviceBridge } from "./bridge.js";
import { DeviceIpc } from "./ipc.js";
import { Device } from "./rpc.js";
import { contentPoint, createViewer, type ViewerState } from "./viewer.js";
// @ts-expect-error Vite owns CSS side-effect imports in the GUI bundle.
import styles from "./gui.css?inline";

const PANEL_TAB = "device";

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
      const [busy, setBusy] = createSignal<string>();
      const [error, setError] = createSignal<string>();
      const [connectionError, setConnectionError] = createSignal<string>();
      const [viewerState, setViewerState] = createSignal<ViewerState>("idle");
      const [viewer, setViewer] = createSignal<ReturnType<typeof createViewer>>();
      const [canvas, setCanvas] = createSignal<HTMLCanvasElement>();
      const scope = () => ({
        sessionID: props.sessionID,
        serverID: props.serverID,
        location: props.location,
      });
      const attachment = () =>
        bridge.state()?.find((entry) => scopeKey(entry.scope) === scopeKey(scope()))?.state ??
        undefined;
      const attachmentToken = createMemo(() => attachment()?.handle.token);
      const startupMessage = createMemo(() => {
        if (connectionError() || error()) return;
        if (busy() === "list") return "Finding devices...";
        if (!busy() && !attachment() && devices().length === 0)
          return "No Android Virtual Devices found.";
        if (busy() === "open") {
          return devices().find((device) => device.id === selectedDevice())?.state === "shutdown"
            ? "Booting up device..."
            : "Connecting to device...";
        }
        if (
          attachment()?.capabilities.supported.includes("stream") &&
          (viewerState() === "idle" || viewerState() === "connecting")
        ) {
          return "Almost done, preparing the screen...";
        }
      });
      let pointerStart: Device.LogicalPoint | undefined;

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

      const outcome = async (name: string, action: () => Promise<DeviceBridge.Outcome>) => {
        setBusy(name);
        setError(undefined);
        try {
          const result = await action();
          if (result.type === "failure") {
            setError(`${result.error.code}: ${result.error.message}`);
            return;
          }
          return result.value;
        } catch (cause) {
          setError(message(cause));
        } finally {
          setBusy(undefined);
        }
      };

      const refresh = async () => {
        const value = await outcome("list", () =>
          bridge.list({ platform: "android", serverID: props.serverID }),
        );
        if (value?.type !== "devices") return;
        setDevices(value.devices);
        const current = attachment();
        if (current) {
          setSelectedDevice(
            value.devices.find((device) => device.id === current.handle.deviceId)?.id ??
              value.devices.find((device) => device.state !== "shutdown")?.id ??
              value.devices[0]?.id ??
              "",
          );
          return;
        }
        const first = value.devices[0];
        if (first) await selectDevice(first.id);
      };

      const selectDevice = async (id: string) => {
        const previous = selectedDevice();
        setSelectedDevice(id);
        const value = await outcome("open", async () => {
          await connect(scope());
          const current = attachment();
          if (current) {
            const closed = await bridge.manual({
              scope: scope(),
              operation: { type: "close", handle: current.handle },
            });
            if (closed.type === "failure") return closed;
          }
          const device = devices().find((item) => item.id === id);
          if (!device) throw new Error("The selected device is no longer available.");
          return bridge.manual({
            scope: scope(),
            operation: {
              type: "open",
              platform: device.platform,
              deviceId: device.id,
              boot: device.state === "shutdown",
            },
          });
        });
        if (!value) setSelectedDevice(attachment() ? previous : "");
      };

      const detach = async () => {
        const current = attachment();
        if (!current) return;
        const closed = await outcome("close", () =>
          bridge.manual({ scope: scope(), operation: { type: "close", handle: current.handle } }),
        );
        if (!closed) return;
        setSelectedDevice("");
      };

      createEffect(() => {
        scope();
        void refresh();
      });

      createEffect(() => {
        const token = attachmentToken();
        const surface = canvas();
        const current = untrack(attachment);
        setViewerState("idle");
        if (
          !current ||
          current.handle.token !== token ||
          !surface ||
          !current.capabilities.supported.includes("stream")
        )
          return;
        const abort = new AbortController();
        void bridge
          .stream({ scope: scope(), handle: current.handle }, { signal: abort.signal })
          .then(
            (result) => {
              if (abort.signal.aborted) return;
              if (result.type === "failure") {
                setError(`${result.error.code}: ${result.error.message}`);
                return;
              }
              setViewer(
                createViewer({
                  canvas: surface,
                  stream: result.stream,
                  onState: setViewerState,
                  onError: setError,
                }),
              );
            },
            (cause) => {
              if (!abort.signal.aborted) setError(message(cause));
            },
          );
        onCleanup(() => {
          abort.abort();
          viewer()?.destroy();
          setViewer(undefined);
        });
      });

      createEffect(() => viewer()?.active(panel.visible()));

      const manual = (operation: DeviceBridge.Operation) =>
        outcome(operation.type, () => bridge.manual({ scope: scope(), operation }));
      const point = (event: PointerEvent) => {
        const surface = canvas();
        if (!surface) return;
        return contentPoint(surface.getBoundingClientRect(), surface, {
          x: event.clientX,
          y: event.clientY,
        });
      };
      const pointerDown = (event: PointerEvent) => {
        if (event.button !== 0) return;
        pointerStart = point(event);
        const surface = canvas();
        if (!pointerStart || !surface) return;
        surface.focus();
        surface.setPointerCapture(event.pointerId);
      };
      const pointerUp = (event: PointerEvent) => {
        const current = attachment();
        const from = pointerStart;
        const to = point(event);
        pointerStart = undefined;
        const surface = canvas();
        if (!current || !from || !to || !surface) return;
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
              style={{ visibility: attachment() ? "visible" : "hidden" }}
              tabIndex={0}
              onPointerDown={pointerDown}
              onPointerUp={pointerUp}
              onPointerCancel={() => (pointerStart = undefined)}
            />
            <Show when={startupMessage()}>
              <div
                class="device-panel__viewer-state"
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
            <ctx.ui.Tooltip value="Refresh devices">
              <button
                type="button"
                class="device-panel__action"
                aria-label="Refresh devices"
                disabled={!!busy()}
                onClick={() => void refresh()}
              >
                <ctx.ui.Icon name="refresh" size="small" />
              </button>
            </ctx.ui.Tooltip>
            <select
              class="device-panel__device-select"
              aria-label="Device"
              value={selectedDevice()}
              onChange={(event) => void selectDevice(event.currentTarget.value)}
              disabled={!!busy() || devices().length === 0}
            >
              <option value="" disabled>
                {devices().length ? "Select device" : "No devices"}
              </option>
              <For each={devices()}>
                {(device) => <option value={device.id}>{device.name}</option>}
              </For>
            </select>
            <ctx.ui.Tooltip value="Detach device">
              <button
                type="button"
                class="device-panel__action"
                aria-label="Detach device"
                disabled={!attachment() || !!busy()}
                onClick={() => void detach()}
              >
                <ctx.ui.Icon name="close" size="small" />
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
                disabled={!attachment() || !!busy()}
                onChange={(enabled) =>
                  void outcome("access", () => bridge.access({ scope: scope(), enabled }))
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
