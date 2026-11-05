import { rm } from "node:fs/promises";
import type { Automation } from "./automation.js";
import { closeArgs } from "./automation.js";
import type { PlatformBackend } from "./backends.js";
import { deviceError, isDeviceFailure } from "./errors.js";
import type { HubConnection } from "./hub-connection.js";

// Completed cleanup steps stay completed. Failed steps retain their resources and can be retried.
export class DeviceResources {
  closing = false;
  automation: Automation | undefined;
  hub: HubConnection | undefined;
  stateDir: string | undefined;
  private pending: Promise<void> | undefined;
  private readonly extraStops = new Set<() => Promise<void>>();

  constructor(
    readonly backend: PlatformBackend,
    readonly deviceId: string,
    private bootedByUs: boolean,
  ) {}

  retainStop(stop: () => Promise<void>): void {
    this.extraStops.add(stop);
  }

  close(shutdown = false): Promise<void> {
    this.closing = true;
    return (this.pending ??= this.cleanup(shutdown).finally(() => {
      this.pending = undefined;
    }));
  }

  private async cleanup(shutdown: boolean): Promise<void> {
    const results = await Promise.allSettled([
      this.closeAutomation(),
      this.stopHub(),
      this.shutdownDevice(shutdown),
      ...[...this.extraStops].map((stop) =>
        stop().then(() => {
          this.extraStops.delete(stop);
        }),
      ),
    ]);
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) {
      const detail = errors
        .map((error) => (error instanceof Error ? error.message : String(error)))
        .join("; ")
        .slice(0, 1_500);
      throw deviceError(
        "helper-failed",
        `Device cleanup failed: ${detail}`,
        errors.some((error) => isDeviceFailure(error) && error.mayHaveExecuted),
      );
    }
    if (this.stateDir) await rm(this.stateDir, { recursive: true, force: true });
  }

  private async closeAutomation(): Promise<void> {
    if (!this.automation) return;
    this.automation.require(await this.automation.run(closeArgs(), 10_000), "Closing automation");
    this.automation = undefined;
  }

  private async stopHub(): Promise<void> {
    if (!this.hub) return;
    await this.hub.stop();
    this.hub = undefined;
  }

  private async shutdownDevice(requested: boolean): Promise<void> {
    if (!requested || !this.bootedByUs) return;
    await this.backend.shutdown(this.deviceId);
    this.bootedByUs = false;
  }
}
