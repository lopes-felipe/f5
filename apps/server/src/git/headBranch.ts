// `--short` and `--abbrev-ref` print `heads/<name>` when a tag shares the branch's name, so
// branch reads take the full ref from `symbolic-ref --quiet HEAD` and strip the prefix here.
export function branchNameFromHeadRef(value: string): string | null {
  const ref = value.trim();
  return ref.startsWith("refs/heads/") && ref.length > "refs/heads/".length
    ? ref.slice("refs/heads/".length)
    : null;
}
