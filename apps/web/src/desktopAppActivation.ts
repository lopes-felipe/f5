/** Reuse a checkout across symlink spellings and case-insensitive Windows paths. */
export function findActivationProject<T extends { cwd: string }>(
  projects: readonly T[],
  directory: string,
  realPath: (value: string) => string | null = (value) => value,
): T | undefined {
  const normalize = (value: string) => {
    try {
      value = realPath(value) ?? value;
    } catch {
      /* A missing checkout keeps its original path. */
    }
    const normalized = value.replaceAll("\\", "/").replace(/\/$/, "");
    return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
  };
  const target = normalize(directory);
  return projects.find((project) => normalize(project.cwd) === target);
}
