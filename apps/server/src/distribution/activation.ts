// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
let stopLauncherChild: () => void = () => {};
const launcherStopped = new Promise<void>((resolve) => {
  stopLauncherChild = resolve;
});
/** Latches even a stop received before the server's Effect runtime has started. */
export const waitForLauncherStop = (): Promise<void> => launcherStopped;
/** Installed children shut down through their runtime finalizers on IPC stop or launcher loss. */
export function watchLauncher(
  host: {
    readonly env: NodeJS.ProcessEnv;
    once(event: "disconnect", listener: () => void): unknown;
    on(event: "message", listener: (message: unknown) => void): unknown;
  } = process,
  stop = stopLauncherChild,
): void {
  if (host.env.F5_LAUNCHER_CHILD !== "1") return;
  host.once("disconnect", stop);
  host.on("message", (message: unknown) => {
    if (message && typeof message === "object" && "type" in message && message.type === "stop")
      stop();
  });
}
let activation: Promise<void> | undefined;
export function waitForActivation(): Promise<void> {
  if (process.env.F5_UPDATE_TRIAL !== "1") return Promise.resolve();
  if (activation) return activation;
  if (!process.send || !process.connected || !process.env.F5_UPDATE_ID)
    return Promise.reject(new Error("Update trial requires its launcher and correlation ID."));
  const id = process.env.F5_UPDATE_ID;
  activation = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Update activation timed out."));
    }, 120_000);
    const message = (value: unknown) => {
      if (
        value &&
        typeof value === "object" &&
        "type" in value &&
        value.type === "activate" &&
        "id" in value &&
        value.id === id
      ) {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      process.off("message", message);
    };
    process.on("message", message);
  });
  return activation;
}
export async function awaitActivation(): Promise<void> {
  if (process.env.F5_UPDATE_TRIAL !== "1") return;
  const gate = waitForActivation();
  await new Promise<void>((resolve, reject) =>
    process.send!({ type: "prepared", id: process.env.F5_UPDATE_ID }, (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  await gate;
}
export function reportActive(): void {
  if (process.env.F5_LAUNCHER_CHILD === "1" && process.connected)
    process.send?.({ type: "active", id: process.env.F5_UPDATE_ID ?? "" });
}
export function updateBootstrapOutcome():
  | { id: string; outcome: "committed" | "rolled-back"; version: string }
  | undefined {
  const id = process.env.F5_UPDATE_ID;
  const outcome = process.env.F5_UPDATE_OUTCOME;
  const version = process.env.F5_UPDATE_VERSION;
  return id && version && (outcome === "committed" || outcome === "rolled-back")
    ? { id, outcome, version }
    : undefined;
}
