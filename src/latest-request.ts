export function createLatestRequest(callbacks: {
  pending(value: boolean): void;
  error(cause: unknown): void;
}) {
  let current: AbortController | undefined;
  return {
    async run<Value>(
      action: (signal: AbortSignal) => Promise<Value>,
      apply: (value: Value) => void,
    ) {
      current?.abort();
      const request = new AbortController();
      current = request;
      callbacks.pending(true);
      try {
        const value = await action(request.signal);
        if (current === request) apply(value);
      } catch (cause) {
        if (current === request && !request.signal.aborted) callbacks.error(cause);
      } finally {
        if (current === request) {
          current = undefined;
          callbacks.pending(false);
        }
      }
    },
    cancel() {
      current?.abort();
      current = undefined;
      callbacks.pending(false);
    },
  };
}
