import { Effect } from "effect";
import {
  PreparationError,
  WorktreePreparations,
  type WorktreePreparationReceipt,
  type WorktreeGroupPlan,
} from "./Services/WorktreePreparations.ts";

/** In-memory test double; production uses the mandatory SQL repository. */
export function makeMemoryWorktreePreparations() {
  const rows: WorktreePreparationReceipt[] = [];
  const groups = new Map<string, WorktreeGroupPlan>();
  const layoutPhases = new Map<string, string>();
  const roots = new Map<string, Set<string>>();
  return WorktreePreparations.of({
    getGroupLayoutPhase: (path) =>
      Effect.sync(() => layoutPhases.get(path) ?? (groups.has(path) ? "pending" : null)),
    setGroupLayoutPhase: (path, phase) =>
      Effect.sync(() => {
        layoutPhases.set(path, phase);
      }),
    listProjectRepositoryRoots: (id) => Effect.sync(() => [...(roots.get(id) ?? [])].sort()),
    setProjectRepositoryRoot: (id, path, tracked) =>
      Effect.sync(() => {
        const selected = roots.get(id) ?? new Set<string>();
        if (tracked) selected.add(path);
        else selected.delete(path);
        roots.set(id, selected);
      }),
    getGroup: (path) => Effect.sync(() => groups.get(path) ?? null),
    saveGroup: (group) =>
      Effect.suspend(() => {
        const existing = groups.get(group.path);
        if (existing && JSON.stringify(existing) !== JSON.stringify(group))
          return Effect.fail(
            new PreparationError({ message: "Worktree group ownership changed." }),
          );
        groups.set(group.path, group);
        return Effect.void;
      }),
    updateGroupBranch: (group, branch) =>
      Effect.gen(function* () {
        const current = groups.get(group.path);
        if (
          current?.threadId !== group.threadId ||
          current.projectRoot !== group.projectRoot ||
          current.branch !== group.branch
        )
          return yield* new PreparationError({ message: "Worktree group changed." });
        groups.set(group.path, { ...current, branch });
      }),
    deleteGroup: (group) =>
      Effect.sync(() => {
        if (groups.get(group.path)?.threadId === group.threadId) {
          groups.delete(group.path);
          layoutPhases.delete(group.path);
        }
      }),
    unfinished: Effect.sync(() =>
      rows.filter((row) => !["completed", "skipped"].includes(row.phase)),
    ),
    latest: (path) => Effect.sync(() => rows.findLast((row) => row.path === path) ?? null),
    listByOwner: (owner) =>
      Effect.sync(() => rows.filter((row) => row.owner === owner).toReversed()),
    branchReserved: (repositoryIdentity, branch) =>
      Effect.sync(() =>
        rows.some(
          (row) =>
            row.repositoryIdentity === repositoryIdentity &&
            row.branch === branch &&
            !["completed", "skipped"].includes(row.phase),
        ),
      ),
    allocate: (input) =>
      Effect.gen(function* () {
        const existing = rows.find((row) => row.operationId === input.operationId);
        if (existing) return existing;
        const latest = rows.findLast((row) => row.path === input.path);
        if (latest && !["completed", "skipped"].includes(latest.phase))
          return yield* new PreparationError({
            message: "This path has an unfinished preparation.",
            path: input.path,
          });
        const receipt = {
          ...input,
          phase: "allocated" as const,
          version: 0,
          createdCheckout: false,
          error: null,
          result: null,
        };
        rows.push(receipt);
        return receipt;
      }),
    update: (receipt, patch) =>
      Effect.gen(function* () {
        const index = rows.findIndex((row) => row.operationId === receipt.operationId);
        if (index === -1 || rows[index]!.version !== receipt.version)
          return yield* new PreparationError({
            message: "Preparation changed; refresh before retrying.",
          });
        const next = { ...receipt, ...patch, version: receipt.version + 1 };
        rows[index] = next;
        return next;
      }),
    reconcile: Effect.sync(() => {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        if (row.phase === "setup_running")
          rows[i] = {
            ...row,
            phase: "setup_indeterminate",
            version: row.version + 1,
            error: "Explicit retry required.",
          };
      }
    }),
  });
}
