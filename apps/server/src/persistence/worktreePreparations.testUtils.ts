import { Effect } from "effect";
import {
  PreparationError,
  WorktreePreparations,
  type WorktreePreparationReceipt,
} from "./Services/WorktreePreparations.ts";

/** In-memory test double; production uses the mandatory SQL repository. */
export function makeMemoryWorktreePreparations() {
  const rows: WorktreePreparationReceipt[] = [];
  return WorktreePreparations.of({
    unfinished: Effect.sync(() =>
      rows.filter((row) => !["completed", "skipped"].includes(row.phase)),
    ),
    latest: (path) => Effect.sync(() => rows.findLast((row) => row.path === path) ?? null),
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
