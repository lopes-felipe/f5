/** Coordinates install preparation and native handoff without recovering during cleanup. */
export function createUpdateInstaller(options: {
  canInstall(): boolean;
  confirm(): Promise<boolean>;
  stage?(): Promise<void>;
  onStageStart?(): void;
  onCancel?(): void;
  prepare(): Promise<boolean>;
  /** Runs once cleanup succeeded, right before the native installer handoff. */
  onPrepared?(): void;
  install(): void | Promise<void>;
  resetAttempt?(): void;
  recover(message: string): Promise<void>;
  watchdogEnabled?: boolean;
  timeoutMs?: number;
}) {
  let phase: "idle" | "preparing" | "installing" | "recovering" = "idle";
  let recovery: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const recover = (message: string) => {
    if (phase === "idle") return Promise.resolve();
    if (!recovery) {
      phase = "recovering";
      clearTimeout(timer);
      recovery = Promise.resolve()
        .then(async () => {
          options.resetAttempt?.();
          await options.recover(message);
        })
        .finally(() => {
          phase = "idle";
        });
    }
    return recovery;
  };
  return {
    get pending() {
      return phase !== "idle";
    },
    onError(message: string): Promise<void> {
      // A late check error cannot interrupt confirmation, staging, or cleanup.
      // stage/prepare failures are handled by their own awaited promises.
      return phase === "installing" || phase === "recovering"
        ? recover(message)
        : Promise.resolve();
    },
    async request(): Promise<{ accepted: boolean; completed: boolean }> {
      if (phase !== "idle" || !options.canInstall()) return { accepted: false, completed: false };
      phase = "preparing";
      recovery = null;
      try {
        if (!(await options.confirm())) {
          phase = "idle";
          options.onCancel?.();
          return { accepted: false, completed: false };
        }
        options.onStageStart?.();
        await options.stage?.();
        if (!(await options.prepare())) {
          phase = "idle";
          options.onCancel?.();
          return { accepted: false, completed: false };
        }
        phase = "installing";
        options.onPrepared?.();
        if (options.watchdogEnabled !== false) {
          timer = setTimeout(() => {
            void recover("F5 did not restart. Try installing the update again.");
          }, options.timeoutMs ?? 60_000);
          timer.unref?.();
        }
        await options.install();
        // An updater can emit an error synchronously without throwing.
        if (recovery) {
          await recovery;
          return { accepted: true, completed: false };
        }
        return { accepted: true, completed: true };
      } catch (error) {
        await recover(error instanceof Error ? error.message : String(error));
        return { accepted: true, completed: false };
      }
    },
  };
}
