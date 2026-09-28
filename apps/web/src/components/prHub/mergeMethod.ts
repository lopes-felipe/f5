export type PrMergeMethod = "squash" | "merge" | "rebase";
export function resolveMergeMethod(input: {
  current?: PrMergeMethod | null | undefined;
  configured?: PrMergeMethod | null | undefined;
  lastUsed?: PrMergeMethod | null | undefined;
  allowed: readonly PrMergeMethod[];
}): PrMergeMethod | null {
  return (
    [input.current, input.configured, input.lastUsed, "squash", "merge", "rebase"].find(
      (method): method is PrMergeMethod =>
        method != null && input.allowed.includes(method as PrMergeMethod),
    ) ?? null
  );
}
