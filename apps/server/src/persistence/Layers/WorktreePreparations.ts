import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  PreparationError,
  WorktreePreparations,
  type WorktreePreparationReceipt,
} from "../Services/WorktreePreparations.ts";

export const makeWorktreePreparations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const queryError = (cause: unknown) =>
    new PreparationError({ message: `Cannot persist worktree preparation: ${String(cause)}` });
  type Row = Omit<WorktreePreparationReceipt, "runSetupScript" | "createdCheckout"> & {
    runSetupScript: number;
    createdCheckout: number;
  };
  const select = sql<Row>`SELECT operation_id AS "operationId", repository_identity AS "repositoryIdentity",
    project_identity AS "projectIdentity", owner, requested_base AS "requestedBase", base_oid AS "baseOid",
    path, branch, created_checkout AS "createdCheckout", naming_intent AS "namingIntent", setup_identity AS "setupIdentity",
    run_setup_script AS "runSetupScript", phase, version, error, result_json AS result
    FROM worktree_preparations`;
  const decode = (row: Row): WorktreePreparationReceipt => ({
    ...row,
    runSetupScript: row.runSetupScript === 1,
    createdCheckout: row.createdCheckout === 1,
  });
  const latest = (path: string) =>
    sql<Row>`${select} WHERE path = ${path} ORDER BY created_at DESC, rowid DESC LIMIT 1`.pipe(
      Effect.map((rows) => (rows[0] ? decode(rows[0]) : null)),
      Effect.mapError(queryError),
    );
  const branchReserved = (repository: string, branch: string) =>
    sql`
    SELECT 1 FROM worktree_preparations WHERE repository_identity = ${repository} AND branch = ${branch}
    AND phase IN ('allocated', 'checkout_created', 'setup_running', 'setup_failed', 'setup_indeterminate') LIMIT 1
  `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(queryError),
    );
  return WorktreePreparations.of({
    unfinished: sql<Row>`${select} WHERE phase NOT IN ('completed', 'skipped')`.pipe(
      Effect.map((rows) => rows.map(decode)),
      Effect.mapError(queryError),
    ),
    latest,
    branchReserved,
    allocate: (input) =>
      Effect.gen(function* () {
        const existing = yield* latest(input.path);
        if (input.owner.startsWith("thread:") || input.owner.startsWith("workflow:")) {
          const previous = yield* sql<Row>`${select} WHERE owner = ${input.owner}
            AND (branch = ${input.branch} OR phase IN ('allocated', 'checkout_created', 'setup_running', 'setup_failed', 'setup_indeterminate'))
            ORDER BY created_at DESC, rowid DESC LIMIT 1`.pipe(Effect.mapError(queryError));
          const prior = previous[0];
          if (
            prior &&
            prior.path !== input.path &&
            (prior.repositoryIdentity !== input.repositoryIdentity ||
              !["completed", "skipped"].includes(prior.phase))
          )
            return yield* new PreparationError({
              message:
                "This owner's repository or preparation identity changed. Inspect the retained checkout before allocating another.",
              path: prior.path,
              operationId: prior.operationId,
              recoveryRequired: true,
            });
        }

        if (existing?.operationId === input.operationId) {
          for (const key of Object.keys(input) as (keyof typeof input)[]) {
            if (key === "baseOid" && existing.phase === "allocated" && !existing.createdCheckout)
              continue;
            if (existing[key] !== input[key])
              return yield* new PreparationError({
                message: "Preparation identity changed; inspect the retained checkout.",
                path: input.path,
                operationId: existing.operationId,
                recoveryRequired: true,
              });
          }
          if (existing.baseOid !== input.baseOid) {
            const updated =
              yield* sql`UPDATE worktree_preparations SET base_oid = ${input.baseOid}, version = version + 1,
            updated_at = ${new Date().toISOString()} WHERE operation_id = ${input.operationId} AND version = ${existing.version}
            AND phase = 'allocated' RETURNING version`.pipe(Effect.mapError(queryError));
            if (updated.length !== 1)
              return yield* new PreparationError({
                message: "The preparation changed before checkout.",
                path: input.path,
              });
            return { ...existing, baseOid: input.baseOid, version: existing.version + 1 };
          }
          return existing;
        }
        if (existing && !["completed", "skipped"].includes(existing.phase))
          return yield* new PreparationError({
            message:
              "This path already has an unfinished preparation. Retry that operation; the checkout was retained.",
            path: input.path,
            operationId: existing.operationId,
            recoveryRequired: true,
          });
        const at = new Date().toISOString();
        yield* sql`INSERT INTO worktree_preparations
        (operation_id, repository_identity, project_identity, owner, requested_base, base_oid, path, branch,
         naming_intent, setup_identity, run_setup_script, phase, version, created_at, updated_at)
        VALUES (${input.operationId}, ${input.repositoryIdentity}, ${input.projectIdentity}, ${input.owner},
          ${input.requestedBase}, ${input.baseOid}, ${input.path}, ${input.branch}, ${input.namingIntent},
          ${input.setupIdentity}, ${input.runSetupScript ? 1 : 0}, 'allocated', 0, ${at}, ${at})`.pipe(
          Effect.mapError(queryError),
        );
        return {
          ...input,
          phase: "allocated" as const,
          createdCheckout: false,
          version: 0,
          error: null,
          result: null,
        };
      }),
    update: (receipt, patch) =>
      Effect.gen(function* () {
        const next = { ...receipt, ...patch, version: receipt.version + 1 };
        const rows =
          yield* sql`UPDATE worktree_preparations SET phase = ${next.phase}, branch = ${next.branch},
        setup_identity = ${next.setupIdentity}, created_checkout = ${next.createdCheckout ? 1 : 0}, version = ${next.version}, error = ${next.error}, result_json = ${next.result}, updated_at = ${new Date().toISOString()}
        WHERE operation_id = ${receipt.operationId} AND version = ${receipt.version} RETURNING operation_id`.pipe(
            Effect.mapError(queryError),
          );
        if (rows.length !== 1)
          return yield* new PreparationError({
            message: "Preparation changed; refresh before retrying.",
            operationId: receipt.operationId,
            path: receipt.path,
            recoveryRequired: true,
          });
        return next;
      }),
    reconcile:
      sql`UPDATE worktree_preparations SET phase = 'setup_indeterminate', version = version + 1,
      error = 'Setup was interrupted. Explicitly retry to acknowledge that the script may have external effects.',
      updated_at = ${new Date().toISOString()} WHERE phase = 'setup_running'`.pipe(
        Effect.asVoid,
        Effect.mapError(queryError),
      ),
  });
});
export const WorktreePreparationsLive = Layer.effect(
  WorktreePreparations,
  makeWorktreePreparations,
);
