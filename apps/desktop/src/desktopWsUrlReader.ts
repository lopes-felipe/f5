/** Cache unavailable runtimes too: frequent HTTP helpers must not synchronously
 * cross IPC on every call while a profile is stopped. */
export function createDesktopWsUrlReader(read: () => string | null, now = Date.now) {
  let value: string | null = null;
  let readAt: number | undefined;
  return () => {
    const at = now();
    if (readAt === undefined || at < readAt || at - readAt >= 60_000) {
      value = read();
      readAt = at;
    }
    return value;
  };
}
