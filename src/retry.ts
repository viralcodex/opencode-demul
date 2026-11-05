import { setTimeout as delay } from "node:timers/promises";

// Retry subscriptions and idempotent cleanup, never device input.
export async function retryUntilStopped(
  action: () => Promise<void>,
  signal: AbortSignal,
  onError: (error: unknown) => void,
  delayMs = 250,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await action();
      return;
    } catch (error) {
      if (signal.aborted) return;
      onError(error);
    }
    try {
      await delay(delayMs, undefined, { signal });
    } catch {
      return;
    }
    delayMs = Math.min(delayMs * 2, 5_000);
  }
}
