import type { ProfileRecord } from "@t3tools/contracts";
import type { ChildProcess } from "node:child_process";

interface ProfileBackendRuntime {
  backendProcess: ChildProcess | null;
  stopped: boolean;
  restartAttempt: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
}

export function isProfileBackendRunning(runtime: ProfileBackendRuntime): boolean {
  const child = runtime.backendProcess;
  return !!child?.pid && !child.killed && child.exitCode === null && child.signalCode === null;
}

/** A retained window and a cached runtime are not evidence of a running backend. */
export async function ensureProfileBackend(
  runtime: ProfileBackendRuntime,
  operations: {
    readonly stop: () => Promise<void>;
    readonly prepare: () => Promise<void>;
    readonly start: () => void;
    readonly ready: () => Promise<void>;
  },
): Promise<void> {
  if (runtime.stopped || !isProfileBackendRunning(runtime)) {
    if (runtime.backendProcess) await operations.stop();
    if (runtime.restartTimer) clearTimeout(runtime.restartTimer);
    runtime.restartTimer = null;
    runtime.restartAttempt = 0;
    runtime.stopped = true;
    await operations.prepare();
    runtime.stopped = false;
    operations.start();
  }
  await operations.ready();
}

export const MAX_BACKEND_RESTART_ATTEMPTS = 6;
/** Confirmed health for this long forgives earlier crashes. */
export const BACKEND_HEALTHY_RESET_MS = 60_000;
const BACKEND_HEALTH_POLL_MS = 1_000;

/**
 * Consecutive failures back off exponentially and stop the profile after
 * {@link MAX_BACKEND_RESTART_ATTEMPTS}; {@link monitorBackendHealth} resets
 * the count once a process has stayed healthy.
 */
export function planBackendRestart(
  runtime: Pick<ProfileBackendRuntime, "restartAttempt">,
): { readonly kind: "stop" } | { readonly kind: "restart"; readonly delayMs: number } {
  if (runtime.restartAttempt >= MAX_BACKEND_RESTART_ATTEMPTS) return { kind: "stop" };
  const delayMs = Math.min(500 * 2 ** runtime.restartAttempt, 10_000);
  runtime.restartAttempt += 1;
  return { kind: "restart", delayMs };
}

/**
 * Waits for the process generation to answer readiness, then calls
 * `onSustainedHealth` if it is still current and ready
 * {@link BACKEND_HEALTHY_RESET_MS} later. Returns a cancel function; a
 * cancelled or superseded monitor never reports health, even when a check
 * was already in flight.
 */
export function monitorBackendHealth(input: {
  readonly isCurrent: () => boolean;
  readonly checkReady: () => Promise<boolean>;
  readonly onSustainedHealth: () => void;
  readonly onReady?: () => void;
  readonly onStartupTimeout?: () => void;
  readonly startupTimeoutMs?: number;
  readonly healthyForMs?: number;
  readonly pollMs?: number;
}): () => void {
  const healthyForMs = input.healthyForMs ?? BACKEND_HEALTHY_RESET_MS;
  const pollMs = input.pollMs ?? BACKEND_HEALTH_POLL_MS;
  let cancelled = false;
  const startedAt = Date.now();
  let timeoutReported = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const active = () => !cancelled && input.isCurrent();
  const schedule = (delayMs: number, next: () => Promise<void>) => {
    if (!active()) return;
    timer = setTimeout(() => {
      timer = null;
      void next();
    }, delayMs);
    timer.unref?.();
  };
  const ready = async () => {
    try {
      return await input.checkReady();
    } catch {
      return false;
    }
  };
  const awaitFirstHealth = async (): Promise<void> => {
    if (!active()) return;
    const isReady = await ready();
    if (!active()) return;
    if (isReady) {
      input.onReady?.();
      schedule(healthyForMs, confirmSustainedHealth);
    } else {
      if (!timeoutReported && Date.now() - startedAt >= (input.startupTimeoutMs ?? 30_000)) {
        timeoutReported = true;
        input.onStartupTimeout?.();
      }
      schedule(pollMs, awaitFirstHealth);
    }
  };
  const confirmSustainedHealth = async (): Promise<void> => {
    if (!active()) return;
    if ((await ready()) && active()) input.onSustainedHealth();
    else schedule(pollMs, awaitFirstHealth);
  };
  schedule(0, awaitFirstHealth);
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

export async function waitForProfileBackend(
  isRunning: () => boolean,
  checkReady: () => Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isRunning()) {
    if (await checkReady()) {
      if (isRunning()) return;
      break;
    }
    if (Date.now() >= deadline)
      throw new Error("Backend startup timed out. Check server-child.log.");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Backend stopped before becoming ready. Check server-child.log.");
}

export const MAX_ACTIVE_PROFILE_BACKENDS = 6;
export const profilePartition = (profile: Pick<ProfileRecord, "id" | "isDefault">) =>
  profile.isDefault ? undefined : `persist:f5-profile-${profile.id}`;
export const profilePreviewPartition = (profile: Pick<ProfileRecord, "id" | "isDefault">) =>
  profile.isDefault ? "persist:f5-preview" : `persist:f5-profile-preview-${profile.id}`;
export const profileWindowArguments = (profileId: string) => [`--f5-profile-id=${profileId}`];

/** Existing windows retain their preload URL when a stopped backend reopens. */
export async function ensureProfileConnection(
  runtime: { backendPort: number; backendAuthToken: string; backendWsUrl: string },
  reservePort: () => Promise<number>,
  mintToken: () => string,
  websocketUrl: (port: number, token: string) => string,
): Promise<void> {
  if (!runtime.backendPort) runtime.backendPort = await reservePort();
  if (!runtime.backendAuthToken) runtime.backendAuthToken = mintToken();
  runtime.backendWsUrl = websocketUrl(runtime.backendPort, runtime.backendAuthToken);
}

/**
 * Coalesce concurrent window/menu requests before asynchronous port allocation. A coalesced
 * call shares the first caller's options.
 */
export function singleProfileOpen<T, O = undefined>(
  open: (id: string, options?: O) => Promise<T>,
): (id: string, options?: O) => Promise<T> {
  const pending = new Map<string, Promise<T>>();
  return (id, options) => {
    const existing = pending.get(id);
    if (existing) return existing;
    const result = Promise.resolve().then(() => open(id, options));
    pending.set(id, result);
    void result
      .finally(() => {
        if (pending.get(id) === result) pending.delete(id);
      })
      .catch(() => {});
    return result;
  };
}
