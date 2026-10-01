import type {
  OrchestrationProject,
  ServerSettings,
  StorageAutomationTarget,
} from "@t3tools/contracts";
import { Cause, Effect, Layer, Schedule, ServiceMap, Stream } from "effect";
import type { Scope } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { NextTurnQueueStore } from "../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  RepositoryBusyError,
  withRepositoryLifecycleLock,
  withWorktreeLifecycleLock,
} from "../project/Layers/WorktreeLifecycleCoordinator.ts";
import { readProjectSettings } from "../project/projectSettings.ts";
import { readWorktreeClaims } from "../project/worktreeClaims.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { recordStorageAutomationAudit } from "../storage/automationAudit.ts";
import { TerminalManager } from "../terminal/Services/Manager.ts";
import { GitCore } from "./Services/GitCore.ts";
import { canonicalWorktreePath } from "./worktreePaths.ts";

/**
 * Keeps clean default-branch checkouts of project roots fast-forwarded.
 * Off by default (`autoPullDefaultBranch`, project-scopable).
 *
 * A project root is pulled only when it has the default branch checked out
 * with an upstream, a clean tree (no untracked files either), no merge,
 * rebase, cherry-pick, revert or bisect in progress, no local commits the
 * upstream lacks, and no agent session working in it. The pull is
 * `git pull --ff-only` under the root's lifecycle lock and the cross-profile
 * repository lock, taken in background mode: when another profile holds the
 * repository the cycle is skipped rather than waited out.
 */
export interface DefaultBranchAutoPullShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly dryRun: Effect.Effect<ReadonlyArray<StorageAutomationTarget>>;
  readonly runOnce: Effect.Effect<ReadonlyArray<StorageAutomationTarget>>;
}

export class DefaultBranchAutoPull extends ServiceMap.Service<
  DefaultBranchAutoPull,
  DefaultBranchAutoPullShape
>()("t3/git/DefaultBranchAutoPull") {}

const STARTUP_DELAY = "45 seconds";
const PULL_INTERVAL = "15 minutes";

interface Candidate {
  readonly project: OrchestrationProject;
  readonly root: string;
}

export const makeDefaultBranchAutoPull = Effect.gen(function* () {
  const services = yield* Effect.services<
    OrchestrationEngineService | TerminalManager | ProviderService | NextTurnQueueStore
  >();
  const sqlServices = yield* Effect.services<SqlClient.SqlClient>();
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettingsService;
  const engine = yield* OrchestrationEngineService;
  const git = yield* GitCore;

  const candidates = (global: ServerSettings) =>
    Effect.gen(function* () {
      const model = yield* engine.getReadModel();
      const seen = new Set<string>();
      const result: Candidate[] = [];
      for (const project of model.projects) {
        if (project.deletedAt !== null) continue;
        const resolved = yield* readProjectSettings(global, project);
        if (!resolved.settings.autoPullDefaultBranch) continue;
        const root = yield* Effect.tryPromise(() =>
          canonicalWorktreePath(project.workspaceRoot),
        ).pipe(Effect.orElseSucceed(() => null));
        if (root === null || seen.has(root)) continue;
        seen.add(root);
        result.push({ project, root });
      }
      return result;
    });

  /** The exact reason a root must not be pulled now, or null. */
  const blockReason = (root: string) =>
    Effect.gen(function* () {
      const details = yield* git.statusDetails(root);
      if (details.branch === null) return { reason: "HEAD is detached", details };
      const defaultBranch = yield* git.readDefaultBranch(root);
      if (defaultBranch === null) return { reason: "no default branch is known", details };
      if (details.branch !== defaultBranch) {
        return { reason: `${details.branch} is checked out, not ${defaultBranch}`, details };
      }
      if (!details.hasUpstream) return { reason: "the branch has no upstream", details };
      if (details.hasWorkingTreeChanges) {
        return { reason: "the checkout has uncommitted or untracked files", details };
      }
      const operation = yield* git.readOperationInProgress(root);
      if (operation !== null) return { reason: `a ${operation} is in progress`, details };
      if (details.aheadCount > 0) {
        return { reason: "the branch has commits its upstream lacks", details };
      }
      const claims = yield* readWorktreeClaims(root).pipe(Effect.provideServices(services));
      if (claims.sessions.length > 0) {
        return { reason: "an agent session is open in the project root", details };
      }
      return { reason: null, details };
    });

  const label = (candidate: Candidate) => candidate.project.title;

  const toTarget = (
    candidate: Candidate,
    reason: string | null,
    behind: number,
  ): StorageAutomationTarget => ({
    job: "auto-pull",
    target: label(candidate),
    projectId: candidate.project.id,
    threadId: null,
    action: reason === null ? "pull" : "skip",
    reason:
      reason ??
      (behind > 0
        ? `${behind} commit(s) behind as of the last fetch`
        : "checks for new upstream commits"),
  });

  const evaluate = (candidate: Candidate) =>
    blockReason(candidate.root).pipe(
      Effect.map(({ reason, details }) => toTarget(candidate, reason, details.behindCount)),
      Effect.catchCause((cause) =>
        Effect.succeed(toTarget(candidate, `git state could not be read: ${firstLine(cause)}`, 0)),
      ),
    );

  const settings = settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));

  const dryRun: DefaultBranchAutoPullShape["dryRun"] = Effect.gen(function* () {
    const global = yield* settings;
    if (global === null) return [];
    return yield* Effect.forEach(yield* candidates(global), evaluate);
  });

  const pull = (operationId: string, candidate: Candidate) =>
    Effect.gen(function* () {
      const commonDir = yield* git.resolveCommonDir(candidate.root);
      return yield* withWorktreeLifecycleLock(
        candidate.root,
        withRepositoryLifecycleLock(
          config.baseDir,
          commonDir,
          Effect.gen(function* () {
            const { reason } = yield* blockReason(candidate.root);
            if (reason !== null) return toTarget(candidate, reason, 0);
            const before = yield* git.resolveCommit(candidate.root, "HEAD");
            const result = yield* git.pullCurrentBranch(candidate.root);
            if (result.status === "skipped_up_to_date") {
              return { ...toTarget(candidate, null, 0), reason: "already up to date" };
            }
            const after = yield* git.resolveCommit(candidate.root, "HEAD");
            yield* recordStorageAutomationAudit({
              operationId,
              job: "auto-pull",
              target: label(candidate),
              projectId: candidate.project.id,
              beforeRef: before,
              afterRef: after,
              result: "pulled",
              reason: `fast-forwarded ${result.branch}`,
            }).pipe(Effect.provideServices(sqlServices));
            return { ...toTarget(candidate, null, 0), reason: `fast-forwarded ${result.branch}` };
          }),
          { mode: "background" },
        ),
      );
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        const busy = Cause.squash(cause) instanceof RepositoryBusyError;
        const reason = firstLine(cause);
        return recordStorageAutomationAudit({
          operationId,
          job: "auto-pull",
          target: label(candidate),
          projectId: candidate.project.id,
          result: busy ? "skipped" : "failed",
          reason,
        }).pipe(Effect.provideServices(sqlServices), Effect.as(toTarget(candidate, reason, 0)));
      }),
    );

  const runOnce: DefaultBranchAutoPullShape["runOnce"] = Effect.gen(function* () {
    const global = yield* settings;
    if (global === null) return [];
    const operationId = crypto.randomUUID();
    const results: StorageAutomationTarget[] = [];
    // One repository at a time; a failure is isolated to its project.
    for (const candidate of yield* candidates(global)) {
      const evaluated = yield* evaluate(candidate);
      results.push(evaluated.action === "pull" ? yield* pull(operationId, candidate) : evaluated);
    }
    return results;
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("default-branch auto-pull failed", { cause: Cause.pretty(cause) }).pipe(
            Effect.as([] as StorageAutomationTarget[]),
          ),
    ),
  );

  const autoPullFields = (value: ServerSettings) =>
    JSON.stringify([
      value.autoPullDefaultBranch,
      Object.entries(value.projectSettingsOverrides).map(([id, overrides]) => [
        id,
        overrides.autoPullDefaultBranch ?? null,
      ]),
    ]);

  const start: DefaultBranchAutoPullShape["start"] = Effect.gen(function* () {
    let running = false;
    const trigger = Effect.suspend(() => {
      if (running) return Effect.void;
      running = true;
      return runOnce.pipe(Effect.ensuring(Effect.sync(() => (running = false))), Effect.asVoid);
    });
    yield* trigger.pipe(
      Effect.delay(STARTUP_DELAY),
      Effect.andThen(trigger.pipe(Effect.repeat(Schedule.spaced(PULL_INTERVAL)))),
      Effect.forkScoped,
    );
    const changes = yield* settingsService.subscribeChanges;
    const initial = yield* settings;
    let last = initial === null ? "" : autoPullFields(initial);
    yield* Stream.runForEach(changes, (value) => {
      const next = autoPullFields(value);
      if (next === last) return Effect.void;
      last = next;
      return trigger.pipe(Effect.forkScoped, Effect.asVoid);
    }).pipe(Effect.forkScoped);
  });

  return { start, dryRun, runOnce } satisfies DefaultBranchAutoPullShape;
});

function firstLine(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]?.trim() || "unknown error";
}

export const DefaultBranchAutoPullLive = Layer.effect(
  DefaultBranchAutoPull,
  makeDefaultBranchAutoPull,
);
