import { lstat } from "node:fs/promises";
import type { GitCreateWorktreeResult, GitPrepareWorktreeInput } from "@t3tools/contracts";
import { Deferred, Effect, Scope, Semaphore } from "effect";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import { canonicalWorktreePath } from "../git/worktreePaths.ts";
import {
  PreparationError,
  type WorktreePreparationsShape,
} from "../persistence/Services/WorktreePreparations.ts";
import type { ProjectSetupScriptRunnerShape } from "./Services/ProjectSetupScriptRunner.ts";

/** Only in-flight requests live in memory. Receipts own replay and restart recovery. */
export const makeWorktreePreparation = <E extends Error>(deps: {
  scope: Scope.Scope;
  git: Pick<
    GitCoreShape,
    "resolveCommonDir" | "resolveCommit" | "allocateWorktreePath" | "inspectCheckout"
  >;
  receipts: WorktreePreparationsShape;
  createWorktree: (
    input: GitPrepareWorktreeInput & { baseRefName: string; path: string; operationId: string },
  ) => Effect.Effect<GitCreateWorktreeResult, E>;
  runSetup: ProjectSetupScriptRunnerShape["runForThread"];
}) =>
  Effect.gen(function* () {
    const gate = yield* Semaphore.make(1);
    const entries = new Map<
      string,
      { fingerprint: string; done: Deferred.Deferred<GitCreateWorktreeResult, Error> }
    >();
    return (input: GitPrepareWorktreeInput): Effect.Effect<GitCreateWorktreeResult, Error> =>
      Effect.gen(function* () {
        // Canonicalization and Git inspection are independent and outside the map semaphore.
        const common = yield* deps.git
          .resolveCommonDir(input.cwd)
          .pipe(Effect.flatMap((path) => Effect.tryPromise(() => canonicalWorktreePath(path))));
        const project = yield* Effect.tryPromise(() => canonicalWorktreePath(input.projectCwd));
        const path = yield* deps.git
          .allocateWorktreePath({ cwd: input.cwd, branch: input.newBranch })
          .pipe(Effect.flatMap((path) => Effect.tryPromise(() => canonicalWorktreePath(path))));
        const owner = `thread:${input.threadId}`;
        const key = JSON.stringify([common, input.newBranch]);
        const fingerprint = JSON.stringify([
          common,
          project,
          owner,
          input.branch,
          input.newBranch,
          input.runSetupScript ?? true,
          input.setupIdentity ?? null,
        ]);
        const done = yield* gate.withPermits(1)(
          Effect.gen(function* () {
            const entry = entries.get(key);
            if (entry) {
              if (entry.fingerprint !== fingerprint)
                return yield* new PreparationError({
                  message: "That recovery branch is already preparing a different workspace.",
                  path,
                });
              return entry.done;
            }
            const done = yield* Deferred.make<GitCreateWorktreeResult, Error>();
            entries.set(key, { fingerprint, done });
            const run = Effect.gen(function* () {
              const receipt = yield* deps.receipts.latest(path);
              const baseOid =
                receipt?.baseOid ?? (yield* deps.git.resolveCommit(input.cwd, input.branch));
              if (!baseOid)
                return yield* new PreparationError({
                  message: `Cannot resolve worktree base '${input.branch}'.`,
                });
              let result: GitCreateWorktreeResult;
              if (receipt) {
                if (
                  receipt.repositoryIdentity !== common ||
                  receipt.projectIdentity !== project ||
                  receipt.owner !== owner ||
                  receipt.requestedBase !== input.branch ||
                  receipt.branch !== input.newBranch ||
                  receipt.runSetupScript !== (input.runSetupScript ?? true) ||
                  (receipt.setupIdentity !== (input.setupIdentity ?? null) &&
                    !input.retryAcknowledged)
                )
                  return yield* new PreparationError({
                    message:
                      "This preparation belongs to a different workspace request. Inspect the retained checkout.",
                    path,
                    operationId: receipt.operationId,
                    recoveryRequired: true,
                  });
                const absent =
                  receipt.phase === "allocated" &&
                  (yield* Effect.tryPromise({
                    try: async () => {
                      try {
                        await lstat(path);
                        return false;
                      } catch (error) {
                        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
                        throw error;
                      }
                    },
                    catch: (cause) =>
                      new PreparationError({
                        message: `Cannot verify the allocated checkout: ${String(cause)}`,
                        path,
                        recoveryRequired: true,
                      }),
                  }));
                if (absent) {
                  result = yield* deps.createWorktree({
                    ...input,
                    baseRefName: baseOid,
                    path,
                    operationId: receipt.operationId,
                  });
                } else {
                  const inspected = yield* deps.git.inspectCheckout(path);
                  if (
                    !inspected.registration ||
                    inspected.canonicalRoot !== path ||
                    inspected.commonDir !== common ||
                    inspected.branch !== input.newBranch
                  )
                    return yield* new PreparationError({
                      message: "The retained checkout identity changed; recovery is required.",
                      path,
                      operationId: receipt.operationId,
                      recoveryRequired: true,
                    });
                  if (
                    (receipt.phase === "setup_running" && receipt.result !== '{"async":true}') ||
                    (receipt.phase === "setup_indeterminate" && !input.retryAcknowledged)
                  )
                    return yield* new PreparationError({
                      message:
                        "Setup may have external effects. Explicitly acknowledge retrying interrupted setup.",
                      path,
                      operationId: receipt.operationId,
                      recoveryRequired: true,
                    });
                  if (receipt.phase === "allocated") {
                    if (
                      !input.retryAcknowledged ||
                      inspected.headSha !== baseOid ||
                      inspected.hasTrackedChanges ||
                      inspected.hasUntrackedChanges ||
                      inspected.ignoredTruncated ||
                      inspected.ignoredEntries.length > 0
                    )
                      return yield* new PreparationError({
                        message:
                          "Creation was interrupted. Confirm setup of the retained checkout before retrying.",
                        path,
                        operationId: receipt.operationId,
                        recoveryRequired: true,
                      });
                    yield* deps.receipts.update(receipt, { phase: "checkout_created" });
                  }
                  result = { worktree: { path, branch: input.newBranch } };
                  if (
                    receipt.phase === "completed" ||
                    receipt.phase === "skipped" ||
                    (receipt.phase === "setup_running" && receipt.result === '{"async":true}')
                  ) {
                    const latest = yield* deps.receipts.latest(path);
                    if (
                      latest?.operationId !== receipt.operationId ||
                      latest.version !== receipt.version
                    )
                      return yield* new PreparationError({
                        message: "Preparation changed while verifying its checkout.",
                        path,
                        recoveryRequired: true,
                      });
                    return result;
                  }
                }
              } else if (input.retryAcknowledged) {
                const inspection = yield* deps.git.inspectCheckout(path);
                if (
                  !inspection.registration ||
                  inspection.commonDir !== common ||
                  inspection.canonicalRoot !== path ||
                  inspection.branch !== input.newBranch ||
                  inspection.headSha !== baseOid ||
                  inspection.hasTrackedChanges ||
                  inspection.hasUntrackedChanges ||
                  inspection.ignoredTruncated ||
                  inspection.ignoredEntries.length > 0
                )
                  return yield* new PreparationError({
                    message:
                      "This checkout cannot be verified for setup reuse. All files were retained.",
                    path,
                    recoveryRequired: true,
                  });
                const adopted = yield* deps.receipts.allocate({
                  operationId: crypto.randomUUID(),
                  repositoryIdentity: common,
                  projectIdentity: project,
                  owner,
                  requestedBase: input.branch,
                  baseOid,
                  path,
                  branch: input.newBranch,
                  namingIntent: "existing",
                  runSetupScript: input.runSetupScript ?? true,
                  setupIdentity: input.setupIdentity ?? null,
                });
                yield* deps.receipts.update(adopted, { phase: "checkout_created" });
                result = { worktree: { path, branch: input.newBranch } };
              } else {
                result = yield* deps.createWorktree({
                  ...input,
                  baseRefName: baseOid,
                  path,
                  operationId: crypto.randomUUID(),
                });
              }
              yield* deps
                .runSetup({
                  threadId: input.threadId,
                  projectCwd: input.projectCwd,
                  worktreePath: result.worktree.path,
                  preferredTerminalId: `setup-${input.newBranch.replaceAll("/", "-")}`,
                  ...(input.retryAcknowledged ? { retry: true } : {}),
                })
                .pipe(
                  Effect.tapError((error) =>
                    Effect.gen(function* () {
                      const latest = yield* deps.receipts.latest(path);
                      if (latest?.phase === "checkout_created")
                        yield* deps.receipts.update(latest, {
                          phase: "setup_failed",
                          error: error.message,
                        });
                    }),
                  ),
                );
              const latest = yield* deps.receipts.latest(path);
              if (latest?.phase === "checkout_created")
                yield* deps.receipts.update(latest, { phase: "completed" });
              return result;
            });
            yield* run.pipe(
              Effect.onExit((exit) =>
                gate.withPermits(1)(
                  Effect.gen(function* () {
                    entries.delete(key);
                    yield* Deferred.done(done, exit);
                  }),
                ),
              ),
              Effect.ignoreCause,
              Effect.forkIn(deps.scope),
            );
            return done;
          }),
        );
        return yield* Deferred.await(done);
      });
  });
