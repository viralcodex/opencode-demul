import { waitWithSignal } from "../cancellation.js";
import type { Device } from "../rpc.js";
import { deviceError } from "./errors.js";
import { startHub, type HubOptions, type HubSession } from "./hub.js";

interface ConnectionOptions {
  initial: HubSession;
  options: HubOptions;
  ready(stream: Device.StreamDescriptor, signal: AbortSignal): Promise<void>;
  onExit(): void;
  start?: typeof startHub;
}

type CaptureState =
  | { type: "active"; hub: HubSession }
  | { type: "idle" | "close-failed" }
  | { type: "opening"; pending: Promise<HubSession> }
  | { type: "closing" | "closed"; pending: Promise<void> };

// Restart capture lazily after a helper exit. Device selection and automation remain attached to the same handle.
export class HubConnection {
  private state: CaptureState;
  private readonly owned = new Set<HubSession>();
  private readonly failedStops = new Set<() => Promise<void>>();
  private readonly lifetime = new AbortController();

  constructor(private readonly connection: ConnectionOptions) {
    this.state = { type: "active", hub: connection.initial };
    this.watch(connection.initial);
  }

  async descriptor(signal?: AbortSignal): Promise<Device.StreamDescriptor> {
    signal?.throwIfAborted();
    if (this.lifetime.signal.aborted)
      throw deviceError("detached", "Device capture is closing; retry closing the attachment.");
    if (this.state.type === "active") return this.state.hub.descriptor;
    if (this.state.type === "idle") this.open();
    if (this.state.type !== "opening")
      throw deviceError("detached", "Device capture is closing; retry closing the attachment.");
    const hub = await waitWithSignal(this.state.pending, signal);
    signal?.throwIfAborted();
    return hub.descriptor;
  }

  stop(): Promise<void> {
    if (this.state.type === "closing" || this.state.type === "closed") return this.state.pending;
    const opening = this.state.type === "opening" ? this.state.pending : undefined;
    this.lifetime.abort();
    const pending = this.close(opening).then(
      () => {
        this.state = { type: "closed", pending };
      },
      (error) => {
        this.state = { type: "close-failed" };
        throw error;
      },
    );
    this.state = { type: "closing", pending };
    return pending;
  }

  private open(): void {
    const opening: Extract<CaptureState, { type: "opening" }> = {
      type: "opening",
      pending: this.reopen().then((hub) => {
        this.lifetime.signal.throwIfAborted();
        if (!this.owned.has(hub))
          throw deviceError("helper-failed", "Device capture exited during recovery.");
        if (this.state === opening) this.state = { type: "active", hub };
        return hub;
      }),
    };
    this.state = opening;
    void opening.pending.catch(() => {
      if (this.state === opening) this.state = { type: "idle" };
    });
  }

  private watch(hub: HubSession): void {
    this.owned.add(hub);
    void hub.process.exited.then(() => {
      this.owned.delete(hub);
      if (this.state.type !== "active" || this.state.hub !== hub) return;
      this.state = { type: "idle" };
      this.connection.onExit();
    });
  }

  private async reopen(): Promise<HubSession> {
    await this.stopOwned();
    this.lifetime.signal.throwIfAborted();
    const hub = await (this.connection.start ?? startHub)({
      ...this.connection.options,
      signal: this.lifetime.signal,
      onCleanupFailure: (stop) => this.failedStops.add(stop),
    });
    this.watch(hub);
    try {
      await this.connection.ready(hub.descriptor, this.lifetime.signal);
      this.lifetime.signal.throwIfAborted();
      if (!this.owned.has(hub))
        throw deviceError("helper-failed", "Device capture exited during recovery.");
      return hub;
    } catch (error) {
      await hub.stop();
      throw error;
    }
  }

  private async close(opening?: Promise<HubSession>): Promise<void> {
    await opening?.catch(() => undefined);
    await this.stopOwned();
  }

  private async stopOwned(): Promise<void> {
    const stops = [...this.owned].map((hub) =>
      hub.stop().then(() => {
        this.owned.delete(hub);
      }),
    );
    for (const stop of this.failedStops) {
      stops.push(
        stop().then(() => {
          this.failedStops.delete(stop);
        }),
      );
    }
    const results = await Promise.allSettled(stops);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }
}
