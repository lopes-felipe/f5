/** Lossless parser for `git worktree list --porcelain -z`. No filesystem IO. */
export interface WorktreeListEntry {
  readonly path: string;
  readonly headSha: string | null;
  readonly branch: string | null;
  readonly bare: boolean;
  readonly detached: boolean;
  readonly locked: string | null;
  readonly prunable: string | null;
  readonly isMain: boolean;
}

export function parseWorktreeListPorcelain(stdoutZ: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let entry: { -readonly [K in keyof WorktreeListEntry]: WorktreeListEntry[K] } | null = null;
  for (const field of stdoutZ.split("\0")) {
    if (field.startsWith("worktree ")) {
      if (entry) entries.push(entry);
      entry = {
        path: field.slice(9),
        headSha: null,
        branch: null,
        bare: false,
        detached: false,
        locked: null,
        prunable: null,
        isMain: entries.length === 0,
      };
    } else if (entry) {
      if (field.startsWith("HEAD ")) entry.headSha = field.slice(5);
      else if (field.startsWith("branch refs/heads/")) entry.branch = field.slice(18);
      else if (field === "bare") entry.bare = true;
      else if (field === "detached") entry.detached = true;
      else if (field === "locked" || field.startsWith("locked ")) entry.locked = field.slice(7);
      else if (field === "prunable" || field.startsWith("prunable "))
        entry.prunable = field.slice(9);
    }
  }
  if (entry) entries.push(entry);
  return entries;
}

/** Git emits one LF after a path; whitespace in the path itself is significant. */
export function stripPathTerminator(stdout: string): string {
  return stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
}
