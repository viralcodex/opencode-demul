import { waitWithSignal } from "./cancellation.js";

// Cancelling queued work rejects promptly, but the queue still waits for the active operation to settle.
export class OperationQueue {
  private pending: Promise<void> = Promise.resolve();

  run<Value>(action: () => Promise<Value>, signal?: AbortSignal): Promise<Value> {
    signal?.throwIfAborted();
    const previous = this.pending;
    const result = waitWithSignal(previous, signal).then(() => {
      signal?.throwIfAborted();
      return action();
    });
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.pending = previous.then(() => settled);
    return result;
  }

  drain(): Promise<void> {
    return this.pending;
  }
}
