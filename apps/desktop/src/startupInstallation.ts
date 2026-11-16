/** Moving can fail (permissions, full disk). Continue from the original location. */
export async function offerApplicationsMove(options: {
  prompt(): Promise<boolean>;
  move(): boolean;
  report(error: unknown): void;
}): Promise<boolean> {
  if (!(await options.prompt())) return false;
  try {
    return options.move();
  } catch (error) {
    options.report(error);
    return false;
  }
}
/** Reopens wait even if a second instance arrives before bootstrap has begun. */
export function createBootstrapGate() {
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: Promise<void> | undefined;
  return {
    start(run: () => Promise<void>) {
      if (!ready) {
        ready = Promise.resolve().then(run);
        release();
      }
      return ready;
    },
    async wait() {
      await started;
      await ready;
    },
  };
}
