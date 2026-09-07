/** Captured PR commands require an explicit host-qualified URL or repository. */
export function isCapturedPrTarget(args: readonly string[], host: string): boolean {
  if (args[0] !== "pr") return true;
  const repoIndex = args.indexOf("--repo");
  const repo = repoIndex >= 0 ? args[repoIndex + 1] : undefined;
  if (repoIndex >= 0) {
    if (!repo) return false;
    const parts = repo.split("/");
    if (parts.length === 3 && parts.shift()?.toLowerCase() !== host) return false;
    if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(part)))
      return false;
  }
  const target = args[2];
  if (target && !target.startsWith("-")) {
    try {
      const url = new URL(target);
      return url.protocol === "https:" && url.host === host && !url.username && !url.password;
    } catch {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*#[1-9][0-9]*)?$/.test(target))
        return false;
    }
  }
  return Boolean(repo);
}
