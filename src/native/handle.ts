import { randomUUID } from "node:crypto";
import { Device } from "../rpc.js";
import { deviceError } from "./errors.js";

// Bind handles to devices and connection generations. Snapshot revisions prevent input against stale screen contents.

interface ActiveHandle {
  handle: Device.DeviceHandle;
  // The current snapshot revision. Every snapshot, relaunch, or manual-input invalidation bumps it.
  revision: number;
}

export class HandleRegistry {
  private readonly active = new Map<string, ActiveHandle>();
  private generation = 0;
  private readonly mintToken: () => string;

  // `mintToken` is injectable so tests get deterministic tokens; production mints a random UUID.
  constructor(mintToken: () => string = () => `dh_${randomUUID()}`) {
    this.mintToken = mintToken;
  }

  // Open a new attachment: mint a handle at a fresh connection generation and start its revision at zero.
  create(platform: Device.Platform, deviceId: string): Device.DeviceHandle {
    this.generation += 1;
    const handle: Device.DeviceHandle = {
      token: this.mintToken() as Device.HandleToken,
      platform,
      deviceId,
      generation: this.generation,
    };
    this.active.set(handle.token, { handle, revision: 0 });
    return handle;
  }

  // Resolve an attached handle, or reject with `detached` when its token or generation no longer matches.
  require(handle: Device.DeviceHandle): Device.DeviceHandle {
    return this.entry(handle).handle;
  }

  // The current snapshot revision for an attached handle.
  revision(handle: Device.DeviceHandle): number {
    return this.entry(handle).revision;
  }

  // Record a new snapshot and return its revision, invalidating every earlier reference for this handle.
  nextSnapshot(handle: Device.DeviceHandle): number {
    const entry = this.entry(handle);
    entry.revision += 1;
    return entry.revision;
  }

  // Invalidate outstanding references after a relaunch or manual input, without producing a new snapshot.
  invalidate(handle: Device.DeviceHandle): void {
    this.entry(handle).revision += 1;
  }

  // Resolve a snapshot reference to its element ref, rejecting a reference whose attachment is gone (`detached`) or
  // whose revision has been superseded (`stale-reference`). A supplied handle must name that same attachment.
  resolveReference(
    reference: Device.SnapshotReference,
    handle?: Device.DeviceHandle,
  ): Device.ElementRef {
    if (handle) this.require(handle);
    if (
      handle &&
      (reference.token !== handle.token || reference.generation !== handle.generation)
    ) {
      throw deviceError(
        "stale-reference",
        "This element reference belongs to a different device; take a new snapshot.",
      );
    }
    const entry = this.active.get(reference.token);
    if (!entry)
      throw deviceError(
        "detached",
        "This device handle is no longer attached; open the device again.",
      );
    if (entry.handle.generation !== reference.generation) {
      throw deviceError(
        "stale-reference",
        "This element reference belongs to an older connection; take a new snapshot.",
      );
    }
    if (entry.revision !== reference.revision) {
      throw deviceError(
        "stale-reference",
        "This element reference is from an older snapshot; take a new snapshot.",
      );
    }
    return reference.ref;
  }

  // Release an attachment. A released token can never be revived; a new connection requires a new handle.
  release(handle: Device.DeviceHandle): void {
    if (!this.active.has(handle.token)) return;
    this.require(handle);
    this.active.delete(handle.token);
  }

  private entry(handle: Device.DeviceHandle): ActiveHandle {
    const entry = this.active.get(handle.token);
    if (!entry || !Device.sameHandle(entry.handle, handle)) {
      throw deviceError(
        "detached",
        "This device handle is no longer attached; open the device again.",
      );
    }
    return entry;
  }
}
