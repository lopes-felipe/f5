/** `gh` accepts `--repo V`, `--repo=V`, and the `-R` short form of both. */
function capturedRepoFlag(args: readonly string[]): string | undefined {
  for (const [index, arg] of args.entries())
    for (const flag of ["--repo", "-R"] as const) {
      if (arg === flag) return args[index + 1] ?? "";
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
    }
  return undefined;
}

function isHostQualifiedRepo(repo: string, host: string): boolean {
  const parts = repo.split("/");
  if (parts.length === 3 && parts.shift()?.toLowerCase() !== host) return false;
  return parts.length === 2 && parts.every((part) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(part));
}

/**
 * Captured PR commands require an explicit host-qualified URL or repository.
 * A bare number or `owner/repo#n` is rejected on purpose: without `--repo` those
 * resolve against whatever remote `cwd` happens to point at, which is not
 * necessarily the host the credential was captured for.
 */
export function isCapturedPrTarget(args: readonly string[], host: string): boolean {
  if (args[0] !== "pr") return true;
  const repo = capturedRepoFlag(args);
  if (repo !== undefined && !isHostQualifiedRepo(repo, host)) return false;
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
  return repo !== undefined;
}
