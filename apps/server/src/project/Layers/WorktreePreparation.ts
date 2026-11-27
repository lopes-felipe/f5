import { timeOrderedUuid } from "@t3tools/shared/ids";
import { threadWorkspaceCwd } from "@t3tools/shared/threadWorkspace";
import { lstat } from "node:fs/promises";
import { CommandId, EventId, WORKTREE_SETUP_TAIL_LINES } from "@t3tools/contracts";
import { projectScriptRuntimeEnv, setupProjectScript } from "@t3tools/shared/projectScripts";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema, Semaphore } from "effect";
import { GitCore } from "../../git/Services/GitCore.ts";
import { canonicalWorktreePath } from "../../git/worktreePaths.ts";
import { NextTurnQueueStore } from "../../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  INTERRUPTED_SCRIPT_RERUN,
  PreparationError,
  SETUP_SCRIPT_INTERRUPTED,
  SETUP_SCRIPT_STOPPED,
  SUBMODULES_INITIALIZING,
  WorktreePreparations,
  needsPreparation,
} from "../../persistence/Services/WorktreePreparations.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { readProjectSettings } from "../projectSettings.ts";
import { startOwnedSetupScript, type OwnedSetupScript } from "../ownedSetupScript.ts";
import {
  WorktreePreparation,
  type PrepareThreadWorktree,
} from "../Services/WorktreePreparation.ts";
import { WorktreeSetupGate } from "../Services/WorktreeSetupGate.ts";
import { withWorktreeLifecycleLock } from "./WorktreeLifecycleCoordinator.ts";

export const makeWorktreePreparationService = Effect.gen(function* () {
  const git = yield* GitCore;
  const settings = yield* ServerSettingsService;
  const engine = yield* OrchestrationEngineService;
  const receipts = yield* WorktreePreparations;
  const gate = yield* WorktreeSetupGate;
  const queue = yield* NextTurnQueueStore;
  const scope = yield* Effect.scope;
  const mutex = yield* Semaphore.make(1);
  const running = new Map<
    string,
    { fingerprint: string; done: Deferred.Deferred<void, PreparationError> }
  >();
  /**
   * The setup scripts this service is running, by checkout. A script stays
   * listed until its outcome is written to the receipt, so "not listed" means
   * nothing more will be written for it.
   */
  const scripts = new Map<string, { readonly kill: Effect.Effect<void>; stopped: boolean }>();
  const canonical = (path: string) =>
    Effect.tryPromise({
      try: () => canonicalWorktreePath(path),
      catch: (cause) =>
        new PreparationError({ message: String(cause), path, recoveryRequired: true }),
    });
  const prepare = (input: PrepareThreadWorktree): Effect.Effect<void, PreparationError> =>
    Effect.gen(function* () {
      // Git/filesystem work never holds the map semaphore.
      const path = yield* canonical(input.worktreePath);
      const fingerprint = JSON.stringify([
        input.threadId,
        input.projectId,
        input.branch,
        input.retry === true,
      ]);
      let ownedFiber: Fiber.Fiber<void, never> | null = null;
      const done = yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          const previous = running.get(path);
          if (previous) {
            if (previous.fingerprint !== fingerprint)
              return yield* new PreparationError({
                message: "A different owner is preparing this checkout.",
                path,
                recoveryRequired: true,
              });
            return previous.done;
          }
          const done = yield* Deferred.make<void, PreparationError>();
          running.set(path, { fingerprint, done });
          let ownedScript: OwnedSetupScript | null = null;
          let scriptHandedOff = false;
          let preparingOperationId: string | null = null;
          const run = Effect.gen(function* () {
            let receipt = yield* withWorktreeLifecycleLock(
              path,
              Effect.gen(function* () {
                const receipt = yield* receipts.latest(path);
                // Readiness is enforced by the caller. Finished receipts need no status scan.
                if (
                  !receipt ||
                  receipt.phase === "completed" ||
                  receipt.phase === "skipped" ||
                  (receipt.phase === "setup_running" && receipt.result === '{"async":true}') ||
                  (receipt.phase === "setup_failed" && !input.retry)
                )
                  return null;
                const inspected = yield* git.inspectCheckout(path);
                // The folder and its repository are the checkout's identity.
                // The agent may have left it on another branch or a detached
                // HEAD, and its setup still belongs to it. Only a creation
                // that was cut off must still be on the branch it was made
                // for: that is part of showing nothing has touched it since.
                if (
                  inspected.commonDir !== receipt.repositoryIdentity ||
                  (receipt.phase === "allocated" && inspected.branch !== input.branch) ||
                  inspected.canonicalRoot !== path ||
                  !inspected.registration
                )
                  return yield* new PreparationError({
                    message:
                      "Checkout identity changed. Inspect the retained worktree before retrying.",
                    path,
                    operationId: receipt.operationId,
                    recoveryRequired: true,
                  });
                if (receipt.phase === "allocated") {
                  const status = inspected;
                  if (
                    status.headSha !== receipt.baseOid ||
                    status.hasTrackedChanges ||
                    status.hasUntrackedChanges ||
                    status.ignoredTruncated ||
                    status.ignoredEntries.length > 0
                  )
                    return yield* new PreparationError({
                      message:
                        "Creation was interrupted; the retained checkout needs explicit recovery.",
                      path,
                      operationId: receipt.operationId,
                      recoveryRequired: true,
                    });
                  if (!input.retry)
                    return yield* new PreparationError({
                      message: "Confirm setup before reusing this interrupted checkout.",
                      path,
                      operationId: receipt.operationId,
                      recoveryRequired: true,
                    });
                  return yield* receipts.update(receipt, { phase: "checkout_created" });
                }
                return receipt;
              }),
            ).pipe(
              Effect.mapError((error) =>
                Schema.is(PreparationError)(error)
                  ? error
                  : new PreparationError({ message: error.message, path }),
              ),
            );
            if (!receipt || receipt.phase === "completed" || receipt.phase === "skipped") return;
            if (receipt.phase === "setup_failed" && !input.retry) return; // Reported failure does not block a turn.
            if (receipt.phase === "setup_running")
              return yield* new PreparationError({
                message: "Setup is already running for this checkout.",
                path,
              });
            const project = (yield* engine.getReadModel()).projects.find(
              (p) => p.id === input.projectId && p.deletedAt === null,
            );
            if (!project)
              return yield* new PreparationError({
                message: "The preparation project is unavailable.",
                path,
              });
            const resolved = yield* readProjectSettings(yield* settings.getSettings, project);
            const script = receipt.runSetupScript ? setupProjectScript(project.scripts) : null;
            if (
              script &&
              receipt.setupIdentity !== null &&
              receipt.setupIdentity !== script.command &&
              !input.retry
            )
              return yield* new PreparationError({
                message:
                  "The setup script changed. Confirm a new preparation request before running it.",
                path,
                recoveryRequired: true,
              });
            const operationId = receipt.operationId;
            const outputTail: string[] = [];
            const report = (error: string | null, started = false) =>
              Effect.gen(function* () {
                const createdAt = new Date().toISOString();
                if (
                  !(yield* engine.getReadModel()).threads.some(
                    (thread) => thread.id === input.threadId && thread.deletedAt === null,
                  )
                )
                  return;
                yield* engine.dispatch({
                  type: "thread.activity.append",
                  commandId: CommandId.makeUnsafe(`worktree-prepared:${timeOrderedUuid()}`),
                  threadId: input.threadId,
                  activity: {
                    id: EventId.makeUnsafe(`worktree-prepared:${input.threadId}`),
                    kind: "worktree.prepared",
                    tone: error ? "error" : "info",
                    summary: started
                      ? "Worktree setup running in the background"
                      : error
                        ? "Worktree setup failed"
                        : "Worktree prepared",
                    payload: {
                      path,
                      operationId,
                      error,
                      outputTail: [...outputTail],
                      setupRunning: started,
                    },
                    turnId: null,
                    createdAt,
                  },
                  createdAt,
                });
              });
            // A restart cut the script off, and nobody asked for it to run again.
            // It may have had effects outside the worktree, so a background
            // script is left alone: the failure is reported and does not hold
            // the turn. A script the agent waits for is run again, once,
            // because the agent needs what it produces.
            // A restart during submodule initialization cut off no script: the
            // initialization is done again below and the script runs as usual.
            const scriptCutOff =
              receipt.phase === "setup_indeterminate" && receipt.result !== SUBMODULES_INITIALIZING;
            const interruptedRerun =
              scriptCutOff &&
              !input.retry &&
              script?.async === false &&
              receipt.result !== INTERRUPTED_SCRIPT_RERUN;
            if (scriptCutOff && !input.retry && !interruptedRerun) {
              yield* withWorktreeLifecycleLock(
                path,
                receipts.update(receipt, {
                  phase: "setup_failed",
                  error: SETUP_SCRIPT_INTERRUPTED,
                }),
              );
              yield* report(SETUP_SCRIPT_INTERRUPTED);
              return;
            }
            receipt = yield* withWorktreeLifecycleLock(
              path,
              receipts.update(receipt, {
                phase: "setup_running",
                error: null,
                // Submodules first; the mark is replaced before the script starts.
                result: SUBMODULES_INITIALIZING,
                setupIdentity: script?.command ?? null,
              }),
            );
            preparingOperationId = operationId;
            const finish = (result: import("effect").Exit.Exit<void, unknown>, stopped = false) =>
              Effect.gen(function* () {
                const interrupted =
                  !stopped && result._tag === "Failure" && Cause.hasInterruptsOnly(result.cause);
                const error = stopped
                  ? SETUP_SCRIPT_STOPPED
                  : result._tag === "Failure"
                    ? Cause.pretty(result.cause)
                    : null;
                const latest = yield* receipts.latest(path);
                if (latest?.operationId === operationId && latest.phase === "setup_running")
                  yield* receipts.update(latest, {
                    phase: interrupted
                      ? "setup_indeterminate"
                      : error
                        ? "setup_failed"
                        : "completed",
                    error: interrupted
                      ? "Setup was interrupted. Explicit retry acknowledges possible external effects."
                      : error,
                    // A shutdown is an interruption too. The marks say what was
                    // running and whether the script was already run again
                    // once, and the next start decides by them: keep them.
                    result:
                      interrupted &&
                      (latest.result === INTERRUPTED_SCRIPT_RERUN ||
                        latest.result === SUBMODULES_INITIALIZING)
                        ? latest.result
                        : JSON.stringify({ path, outputTail }),
                  });
                yield* report(error);
              });
            // Scripts run outside lifecycle locks and belong to the service scope.
            const initialize = yield* git
              .initializeWorktreeSubmodules(path, resolved.settings.worktreeSubmodules)
              .pipe(Effect.exit);
            if (initialize._tag === "Failure") {
              yield* finish(initialize);
              return yield* new PreparationError({
                message: Cause.pretty(initialize.cause),
                path,
                recoveryRequired: true,
              });
            }
            if (!script) {
              yield* finish(Exit.void);
              return;
            }
            // The submodules are in place: from here an interruption cuts off the script.
            receipt = yield* withWorktreeLifecycleLock(
              path,
              receipts.update(receipt, {
                result: interruptedRerun ? INTERRUPTED_SCRIPT_RERUN : null,
              }),
            );
            const process = yield* startOwnedSetupScript({
              command: script.command,
              cwd: path,
              env: projectScriptRuntimeEnv({
                project: { cwd: project.workspaceRoot },
                worktreePath: path,
              }),
              onLine: (line) => {
                outputTail.push(line);
                if (outputTail.length > WORKTREE_SETUP_TAIL_LINES) outputTail.shift();
              },
            });
            ownedScript = process;
            const live = { kill: process.kill, stopped: false };
            scripts.set(path, live);
            const completion = process.exit.pipe(
              Effect.onInterrupt(() => process.kill),
              Effect.flatMap((code) =>
                code === 0
                  ? Effect.void
                  : Effect.fail(
                      new PreparationError({
                        message: `Worktree setup script failed (${code ?? "interrupted"}).${outputTail.length ? `\n${outputTail.join("\n")}` : ""}`,
                        path,
                      }),
                    ),
              ),
              Effect.onExit((result) =>
                finish(result, live.stopped).pipe(
                  Effect.ignoreCause({ log: true }),
                  // Unlisted only once the outcome is written, or could not be.
                  Effect.andThen(
                    Effect.sync(() => {
                      if (scripts.get(path) === live) scripts.delete(path);
                    }),
                  ),
                ),
              ),
            );
            if (script.async ?? true) {
              receipt = yield* receipts.update(receipt, { result: '{"async":true}' });
              yield* report(null, true);
              yield* completion.pipe(Effect.ignoreCause, Effect.forkIn(scope));
              scriptHandedOff = true;
            } else {
              yield* completion.pipe(Effect.ignoreCause); // Script failure is reported; delivery proceeds.
            }
          }).pipe(
            Effect.mapError((error) =>
              Schema.is(PreparationError)(error)
                ? error
                : new PreparationError({ message: error.message, path }),
            ),
          );
          ownedFiber = yield* run.pipe(
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                if (exit._tag === "Failure") {
                  // A failure between spawn and background handoff must not orphan the process.
                  if (ownedScript && !scriptHandedOff) {
                    yield* ownedScript.kill;
                    // Its completion never started, so nothing else unlists it.
                    scripts.delete(path);
                  }
                  const latest = yield* receipts.latest(path);
                  if (
                    latest?.operationId === preparingOperationId &&
                    latest?.phase === "setup_running"
                  )
                    yield* receipts.update(latest, {
                      phase: "setup_indeterminate",
                      error:
                        "Setup was interrupted. Explicit retry acknowledges possible external effects.",
                    });
                }
              }).pipe(
                Effect.ignoreCause({ log: true }),
                Effect.andThen(
                  mutex.withPermits(1)(
                    Effect.gen(function* () {
                      running.delete(path);
                      yield* Deferred.done(done, exit);
                    }),
                  ),
                ),
              ),
            ),
            Effect.ignoreCause,
            Effect.forkIn(scope),
          );
          return done;
        }),
      );
      yield* Deferred.await(done).pipe(
        Effect.onInterrupt(() =>
          ownedFiber ? Fiber.interrupt(ownedFiber).pipe(Effect.asVoid) : Effect.void,
        ),
      );
    });
  return WorktreePreparation.of({
    prepare,
    needsPreparation: (path) =>
      canonical(path).pipe(Effect.flatMap(receipts.latest), Effect.map(needsPreparation)),
    scriptRunning: (path) =>
      canonical(path).pipe(
        Effect.map((checkout) => scripts.has(checkout)),
        Effect.orElseSucceed(() => false),
      ),
    stopScript: (path) =>
      Effect.gen(function* () {
        const live = scripts.get(yield* canonical(path));
        if (!live) return false;
        // Its own completion records the stop on the receipt.
        live.stopped = true;
        yield* live.kill;
        return true;
      }).pipe(Effect.orElseSucceed(() => false)),
    startup: Effect.gen(function* () {
      yield* receipts.reconcile;
      // Startup runs before admitting requests. Reclaim only inactive reservations
      // with no directory or registration; unreadable usage or an ambiguous ref retains them.
      const model = yield* engine.getReadModel();
      for (const receipt of yield* receipts.unfinished) {
        if (receipt.phase !== "allocated" || receipt.createdCheckout) continue;
        yield* Effect.gen(function* () {
          for (const thread of model.threads) {
            const project = model.projects.find((project) => project.id === thread.projectId);
            const workspace = threadWorkspaceCwd(thread, project);
            if (
              `thread:${thread.id}` !== receipt.owner &&
              (!workspace || (yield* canonical(workspace)) !== receipt.path)
            )
              continue;
            const queued = yield* queue.listByThread(thread.id);
            if (
              queued.items.length > 0 ||
              queued.state.worktreeBlockToken !== null ||
              (thread.session &&
                !["stopped", "error", "interrupted"].includes(thread.session.status))
            )
              return;
          }
          const absent = yield* Effect.tryPromise(() => lstat(receipt.path)).pipe(
            Effect.as(false),
            Effect.catch((error) =>
              (error.cause as NodeJS.ErrnoException)?.code === "ENOENT"
                ? Effect.succeed(true)
                : Effect.fail(error),
            ),
          );
          if (
            !absent ||
            (yield* git.listWorktrees(receipt.projectIdentity)).some(
              (entry) => entry.canonicalPath === receipt.path,
            )
          )
            return;
          if (yield* git.branchExists(receipt.projectIdentity, receipt.branch)) {
            // PR preparation checks out an existing branch; an unchanged ref is
            // sufficient to release its unmaterialized intent without touching Git.
            if (
              receipt.namingIntent !== "existing" ||
              (yield* git.resolveCommit(receipt.projectIdentity, receipt.branch)) !==
                receipt.baseOid
            )
              return;
          }
          yield* receipts.update(receipt, {
            phase: "skipped",
            error: "Released an inactive reservation without a checkout.",
          });
        }).pipe(Effect.ignoreCause({ log: true }));
      }
    }),
    startBackground: (input, notify) =>
      Effect.gen(function* () {
        const token = `preparation:${crypto.randomUUID()}`;
        yield* gate.register(input.threadId, token);
        yield* queue.setWorktreeBlockToken({ threadId: input.threadId, token });
        yield* prepare(input).pipe(
          Effect.catch((error) =>
            queue
              .setPaused({
                threadId: input.threadId,
                paused: true,
                reasonCode: "worktree_setup_failed",
                detail: error.message,
              })
              .pipe(Effect.ignoreCause({ log: true })),
          ),
          Effect.ensuring(
            Effect.gen(function* () {
              yield* gate.open(input.threadId, token);
              yield* queue
                .setWorktreeBlockToken({
                  threadId: input.threadId,
                  token: null,
                  expectedToken: token,
                })
                .pipe(Effect.ignoreCause({ log: true }));
              yield* gate.unregister(input.threadId, token);
              yield* notify();
            }),
          ),
          Effect.forkIn(scope),
        );
      }).pipe(
        Effect.mapError((error) =>
          Schema.is(PreparationError)(error)
            ? error
            : new PreparationError({ message: error.message }),
        ),
      ),
  });
});
export const WorktreePreparationLive = Layer.effect(
  WorktreePreparation,
  makeWorktreePreparationService,
);
