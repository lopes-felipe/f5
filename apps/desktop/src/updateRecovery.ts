export interface UpdateWindowSnapshot<Runtime, Window> {
  window: Window;
  runtime: Runtime;
  threadId: string | null;
  bounds: { x: number; y: number; width: number; height: number };
}
interface RecoveryWindow {
  isDestroyed(): boolean;
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
}
export function restoreUpdateWindows<Runtime, Window extends RecoveryWindow>(
  snapshots: readonly UpdateWindowSnapshot<Runtime, Window>[],
  createWindow: (threadId: string | null, runtime: Runtime) => Window,
): void {
  for (const snapshot of snapshots) {
    if (!snapshot.window.isDestroyed()) continue;
    createWindow(snapshot.threadId, snapshot.runtime).setBounds(snapshot.bounds);
  }
}
export async function recoverUpdateSession<Runtime extends { stopped: boolean }>(options: {
  cleanupStarted: boolean;
  initializePreview(): Promise<void>;
  initializeComputer(): void;
  initializeKeepAwake?(): Promise<void>;
  runningBeforeInstall: readonly Runtime[];
  startBackend(runtime: Runtime): void;
  restoreWindows(): void;
  resumeUpdates?(): void;
}): Promise<unknown[]> {
  const errors: unknown[] = [];
  const attempt = async (run: () => unknown) => {
    try {
      await run();
    } catch (error) {
      errors.push(error);
    }
  };
  if (options.cleanupStarted) {
    await attempt(options.initializePreview);
    await attempt(options.initializeComputer);
    if (options.initializeKeepAwake) await attempt(options.initializeKeepAwake);
  }
  for (const runtime of options.runningBeforeInstall) {
    runtime.stopped = false;
    await attempt(() => options.startBackend(runtime));
  }
  await attempt(options.restoreWindows);
  if (options.resumeUpdates) await attempt(options.resumeUpdates);
  return errors;
}
