// Waiting callers may cancel without cancelling a shared task owned by another lifetime.
export function waitWithSignal<Value>(
  pending: Promise<Value>,
  signal?: AbortSignal,
): Promise<Value> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
