/** Abort one waiter without cancelling a shared underlying operation. */
const makeAbortError = () =>
  Object.assign(new Error("The operation was aborted."), { name: "AbortError" });

/** Cancelling one consumer must never cancel the shared underlying RPC. */
export function raceWithAbort<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return request;
  if (signal.aborted) {
    // The shared RPC already exists. Observe an abandoned failure even when
    // this consumer was cancelled before it could attach its own handlers.
    void request.catch(() => undefined);
    return Promise.reject(makeAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(makeAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    request.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
