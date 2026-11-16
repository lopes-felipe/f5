export function createUpdatePoller(
  check: (reason: string) => Promise<void>,
  startupDelayMs: number,
  pollIntervalMs: number,
) {
  let startup: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    clearTimeout(startup);
    clearInterval(poll);
    startup = undefined;
    poll = undefined;
  };
  return {
    stop,
    start(includeStartup = false) {
      stop();
      if (includeStartup) {
        startup = setTimeout(() => {
          startup = undefined;
          void check("startup");
        }, startupDelayMs);
        startup.unref?.();
      }
      poll = setInterval(() => {
        void check("poll");
      }, pollIntervalMs);
      poll.unref?.();
    },
  };
}
