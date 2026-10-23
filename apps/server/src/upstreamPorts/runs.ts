/**
 * Triage runs (plan §4.5): fetch, chunk, digest, triage, record one op per
 * chunk. A run never fails as an Effect; its outcome is the returned record.
 *
 * @module upstreamPorts/runs
 */
import {
  UPSTREAM_LEDGER_SCHEMA_VERSION,
  type UpstreamMembershipCommit,
  type UpstreamProjectConfig,
  type UpstreamTopicState,
} from "@t3tools/contracts";
import {
  addDays,
  coverageTarget,
  digestShas,
  findRevertTarget,
  isOpenForMembership,
  prNumberFromSubject,
  type Rules,
  type UpstreamLedgerOp,
} from "@t3tools/shared/upstreamPorts";
import {
  archiveContext,
  archiveEntriesBySha,
  remainingLegacyShas,
  type Schema6Archive,
} from "@t3tools/shared/upstreamPortsArchive";
import {
  TRIAGE_MAX_OPEN_TOPICS,
  TRIAGE_MAX_PR_BODY_CHARS,
  truncateText,
  type TriageTopicRow,
} from "@t3tools/shared/upstreamPortsPrompts";
import { Data, Effect, Schema } from "effect";

import { GitCommandError } from "../git/Errors.ts";
import {
  isGitTimeout,
  type CommitSource,
  type FirstParentCommit,
  type UpstreamGit,
} from "./git.ts";
import type { RunRecord } from "./store.ts";
import {
  buildTopics,
  legacyEquivalenceGroups,
  ProviderUnavailableError,
  triageChunk,
  type ChunkCommit,
  type PriorCommit,
  type TriageCall,
} from "./triage.ts";
import type { DerivedRow, LedgerView } from "./view.ts";

export const CHUNK_SIZE = 500;
export const RUN_DEADLINE_MS = 60 * 60_000;
export const RUN_CALL_BUDGET = 200;
const RECENT_DAYS = 30;

export class RunFailure extends Data.TaggedError("UpstreamRunFailure")<{
  readonly failureKind: string;
  readonly message: string;
}> {}

const runFailure = (failureKind: string, message: string) =>
  new RunFailure({ failureKind, message });

export interface ViewSnapshot {
  readonly view: LedgerView;
  readonly rows: ReadonlyArray<DerivedRow>;
}

export interface RunContext {
  readonly cwd: string;
  readonly config: UpstreamProjectConfig;
  readonly baseBranch: string;
  readonly git: UpstreamGit;
  /** Upstream PR bodies by number; null when `gh` is unavailable. */
  readonly prBodies:
    | ((numbers: ReadonlyArray<number>) => Effect.Effect<Map<number, string>, Error>)
    | null;
  readonly rules: Rules;
  readonly policy: string;
  readonly archive: Schema6Archive | null;
  /** null runs rules only. */
  readonly triage: TriageCall | null;
  readonly model: string;
  readonly now: () => Date;
  readonly today: () => string;
  /** Fetches `origin/<base>` and returns the refreshed view. */
  readonly refreshView: Effect.Effect<ViewSnapshot, Error>;
  /** The current view without network. */
  readonly currentView: Effect.Effect<ViewSnapshot, Error>;
  /** Records one op (lock, writer check, conflict check, push). */
  readonly record: (op: UpstreamLedgerOp, newInbox: number) => Effect.Effect<void, Error>;
  readonly progress: (run: RunRecord) => Effect.Effect<void>;
  readonly limits?: {
    readonly chunkSize?: number;
    readonly deadlineMs?: number;
    readonly callBudget?: number;
    readonly batchSize?: number;
  };
}

const describe = (error: unknown) =>
  Schema.is(GitCommandError)(error)
    ? error.detail
    : error instanceof Error
      ? error.message
      : String(error);

/** The open-topics table for prompts (plan §4.5 step 6). */
export function openTopicRows(rows: ReadonlyArray<DerivedRow>, today: string): TriageTopicRow[] {
  const since = addDays(today, -RECENT_DAYS);
  const recent = (row: DerivedRow) =>
    (row.topic.decidedAt ?? row.topic.createdAt).slice(0, 10) >= since;
  const visible = (state: UpstreamTopicState, row: DerivedRow) =>
    state === "inbox" ||
    state === "watch" ||
    state === "ready" ||
    state === "in-progress" ||
    recent(row);
  return rows
    .filter((row) => visible(row.state, row))
    .toSorted((a, b) =>
      a.topic.createdAt < b.topic.createdAt ? 1 : a.topic.createdAt > b.topic.createdAt ? -1 : 0,
    )
    .slice(0, TRIAGE_MAX_OPEN_TOPICS)
    .map((row) => ({
      id: row.topic.id,
      state: row.state,
      title: row.topic.title,
      summary: row.topic.summary,
    }));
}

export const attachableTopics = (rows: ReadonlyArray<DerivedRow>) =>
  new Set(
    rows
      .filter(
        (row) =>
          isOpenForMembership(row.topic.status) && (row.state === "inbox" || row.state === "watch"),
      )
      .map((row) => row.topic.id),
  );

/** Retries a chunk's git work once on timeout, then fails the run with `git-timeout`. */
const withChunkRetry = <A>(effect: Effect.Effect<A, GitCommandError>) =>
  effect.pipe(
    Effect.catch((error) => (isGitTimeout(error) ? effect : Effect.fail(error))),
    Effect.mapError((error) =>
      isGitTimeout(error)
        ? runFailure("git-timeout", describe(error))
        : runFailure("git", describe(error)),
    ),
  );

interface ChunkPlan {
  readonly load: Effect.Effect<ReadonlyArray<FirstParentCommit>, RunFailure>;
  readonly source: CommitSource;
}

export function runTriage(context: RunContext, initial: RunRecord): Effect.Effect<RunRecord> {
  const startedAt = context.now().getTime();
  const limits = {
    chunkSize: context.limits?.chunkSize ?? CHUNK_SIZE,
    deadlineMs: context.limits?.deadlineMs ?? RUN_DEADLINE_MS,
    callBudget: context.limits?.callBudget ?? RUN_CALL_BUDGET,
    batchSize: context.limits?.batchSize,
  };
  let run: RunRecord = initial;
  const update = (patch: Partial<RunRecord>) =>
    Effect.gen(function* () {
      run = { ...run, ...patch };
      yield* context.progress(run);
    });

  const body = Effect.gen(function* () {
    const { cwd, config, git } = context;
    const remoteRef = `refs/remotes/${config.remote}/${config.branch}`;
    const baseRef = `refs/remotes/origin/${context.baseBranch}`;

    // 2. Fetch and anchor.
    if (initial.kind === "upstream")
      yield* git.fetchBranch(cwd, config.remote, config.branch).pipe(withChunkRetry);
    const head =
      initial.kind === "upstream" ? yield* git.revParse(cwd, remoteRef).pipe(withChunkRetry) : null;
    if (initial.kind === "upstream" && head === null)
      return yield* runFailure(
        "missing-ref",
        `${config.remote}/${config.branch} is missing after fetch.`,
      );
    let snapshot = yield* context.refreshView.pipe(
      Effect.mapError((error) => runFailure("base", describe(error))),
    );
    const archiveCtx = context.archive ? archiveContext(context.archive) : null;
    const archiveEntries = context.archive ? archiveEntriesBySha(context.archive) : new Map();

    // 3. Chunks.
    let chunks: ChunkPlan[];
    let remainingAfter: number;
    if (initial.kind === "upstream") {
      const target = coverageTarget(snapshot.view.ledger, archiveCtx);
      if (target === null)
        return yield* runFailure("no-coverage", "The ledger has no coverage target.");
      const ancestry = yield* git.firstParentAncestry(cwd, head!).pipe(withChunkRetry);
      if (!ancestry.includes(target))
        return yield* runFailure(
          "diverged",
          `Tracked target ${target.slice(0, 12)} is not on the first-parent history of ${config.remote}/${config.branch}.`,
        );
      const all = [
        ...(yield* git.firstParentCommits({ cwd, from: target, to: head! }).pipe(withChunkRetry)),
      ].toReversed();
      chunks = [];
      let from = target;
      for (let index = 0; index < all.length; index += limits.chunkSize) {
        const slice = all.slice(index, index + limits.chunkSize);
        chunks.push({
          load: Effect.succeed(slice),
          source: { kind: "range", from, to: slice.at(-1)!.sha },
        });
        from = slice.at(-1)!.sha;
      }
      remainingAfter = all.length;
      yield* update({ targetSha: head, remainingCount: all.length });
    } else {
      if (!context.archive)
        return yield* runFailure("no-archive", "There is no archive to triage.");
      const batched = new Set(
        snapshot.view.ledger.legacy.flatMap((file) => file.commits.map((commit) => commit.sha)),
      );
      const shas = remainingLegacyShas(context.archive, batched);
      remainingAfter = shas.length;
      chunks = [];
      for (let index = 0; index < shas.length; index += limits.chunkSize) {
        const next = shas.slice(index, index + limits.chunkSize);
        chunks.push({
          load: git.commitsBySha(cwd, next).pipe(withChunkRetry),
          source: { kind: "shas", shas: next },
        });
      }
      yield* update({ remainingCount: shas.length });
    }

    const forkPaths = yield* git
      .listPathsAtRef(cwd, baseRef)
      .pipe(Effect.orElseSucceed(() => new Set<string>()));
    const reachable =
      initial.kind === "legacy"
        ? yield* git.reachableSet(cwd, baseRef).pipe(Effect.orElseSucceed(() => new Set<string>()))
        : new Set<string>();
    let prBodiesWarned = false;
    const circuit = { consecutiveFailures: 0 };

    for (const chunk of chunks) {
      if (
        context.now().getTime() - startedAt >= limits.deadlineMs ||
        run.llmCalls >= limits.callBudget
      )
        break;
      const chunkCommits = yield* chunk.load;
      const shas = chunkCommits.map((commit) => commit.sha);
      const [numstat, patches] = yield* Effect.all([
        git.streamNumstat(cwd, chunk.source).pipe(withChunkRetry),
        git.streamPatches(cwd, chunk.source).pipe(withChunkRetry),
      ]);
      const prs = [
        ...new Set(
          chunkCommits
            .map((commit) => prNumberFromSubject(commit.subject))
            .filter((pr): pr is number => pr !== null),
        ),
      ];
      let bodies = new Map<number, string>();
      if (context.triage && prs.length) {
        if (context.prBodies) {
          bodies = yield* context.prBodies(prs).pipe(
            Effect.catch((error) =>
              Effect.logWarning("upstreamPorts.run.prBodies.failed", {
                detail: describe(error),
              }).pipe(Effect.as(new Map<number, string>())),
            ),
          );
        } else if (!prBodiesWarned) {
          prBodiesWarned = true;
          yield* Effect.logWarning("upstreamPorts.run.prBodies.unavailable", {
            projectId: initial.projectId,
          });
        }
      }
      const commits: ChunkCommit[] = chunkCommits.map((commit) => {
        const stat = numstat.get(commit.sha);
        const pr = prNumberFromSubject(commit.subject);
        const entry = archiveEntries.get(commit.sha);
        const hints = [
          ...(entry?.plannedWorkstream
            ? [`earlier catch-up planned workstream: ${entry.plannedWorkstream}`]
            : []),
          ...(entry?.reason ? [`earlier catch-up note: ${truncateText(entry.reason, 300)}`] : []),
        ];
        const files = (stat?.files ?? [])
          .filter(
            (file) =>
              !context.rules.ignoredPathPrefixes.some((prefix) => file.path.startsWith(prefix)),
          )
          .map((file) => ({ ...file, existsInFork: forkPaths.has(file.path) }));
        return {
          sha: commit.sha,
          subject: initial.kind === "legacy" && entry ? entry.subject : commit.subject,
          body: commit.body,
          pr,
          paths: stat?.paths ?? [],
          digest: {
            sha: commit.sha,
            subject: commit.subject,
            pr,
            parentCount: commit.parents.length,
            files,
            totalFiles: stat?.totalFiles ?? 0,
            excerpt: patches.get(commit.sha) ?? "",
            prBody:
              pr !== null && bodies.has(pr)
                ? truncateText(bodies.get(pr)!, TRIAGE_MAX_PR_BODY_CHARS)
                : null,
            hints,
          },
        };
      });

      // Revert targets outside the chunk.
      const inChunk = new Set(shas);
      const memberTopic = new Map<string, string>();
      for (const [topicId, members] of snapshot.view.members)
        for (const member of members) memberTopic.set(member.sha, topicId);
      const external = [
        ...new Set(
          commits
            .map((commit) => findRevertTarget(commit.body))
            .filter(
              (sha): sha is string =>
                sha !== null &&
                !inChunk.has(sha) &&
                (memberTopic.has(sha) || archiveEntries.has(sha)),
            ),
        ),
      ];
      const externalStat = external.length
        ? yield* git
            .streamNumstat(cwd, { kind: "shas", shas: external })
            .pipe(Effect.orElseSucceed(() => new Map()))
        : new Map();
      const rowsById = new Map(snapshot.rows.map((row) => [row.topic.id, row]));
      const prior = new Map<string, PriorCommit>();
      for (const sha of external) {
        const paths = externalStat.get(sha)?.paths ?? null;
        const topicId = memberTopic.get(sha);
        const row = topicId ? rowsById.get(topicId) : undefined;
        if (row)
          prior.set(sha, {
            kind: "topic",
            topicId: row.topic.id,
            state: row.state,
            status: row.topic.status,
            paths,
          });
        else {
          const entry = archiveEntries.get(sha);
          if (entry)
            prior.set(sha, {
              kind: "archive",
              disposition: entry.disposition,
              subject: entry.subject,
              paths,
            });
        }
      }

      const presetGroups =
        initial.kind === "legacy" && context.archive
          ? legacyEquivalenceGroups({
              commits,
              f5ShasBySha: new Map(
                [...archiveEntries.values()]
                  .filter((entry) => entry.f5Shas?.length)
                  .map((entry) => [entry.upstreamSha, entry.f5Shas!]),
              ),
              reachable,
            })
          : [];

      const triaged = yield* triageChunk({
        repository: config.repository,
        policy: context.policy,
        rules: context.rules,
        model: context.model,
        commits,
        prior,
        openTopics: openTopicRows(snapshot.rows, context.today()),
        attachable: attachableTopics(snapshot.rows),
        presetGroups,
        triage: context.triage,
        circuit,
        budget: {
          calls: limits.callBudget - run.llmCalls,
          deadlineAt: startedAt + limits.deadlineMs,
          now: () => context.now().getTime(),
        },
        ...(limits.batchSize !== undefined ? { batchSize: limits.batchSize } : {}),
      }).pipe(
        Effect.tapError((error) => update({ llmCalls: run.llmCalls + error.llmCalls })),
        Effect.mapError((error: ProviderUnavailableError) =>
          runFailure("provider-unavailable", error.detail),
        ),
      );

      // 8. Record against the current view.
      snapshot = yield* context.currentView.pipe(
        Effect.mapError((error) => runFailure("base", describe(error))),
      );
      const now = context.now().toISOString();
      const built = buildTopics({
        groups: triaged.groups,
        commits,
        attachable: attachableTopics(snapshot.rows),
        existingIds: new Set(snapshot.view.topicsById.keys()),
        now,
      });
      const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
      const membership = (sha: string): UpstreamMembershipCommit => {
        const commit = bySha.get(sha)!;
        return {
          sha,
          subject: commit.subject,
          ...(commit.pr !== null ? { pr: commit.pr } : {}),
          topic: built.membership.get(sha)!,
        };
      };
      let op: UpstreamLedgerOp;
      if (initial.kind === "upstream") {
        const newestFirst = [...shas].toReversed();
        const intervals = snapshot.view.ledger.intervals;
        op = {
          kind: "interval",
          file: {
            schemaVersion: UPSTREAM_LEDGER_SCHEMA_VERSION,
            interval: intervals.length + 1,
            baseSha:
              chunk.source.kind === "range" ? chunk.source.from : intervals.at(-1)!.targetSha,
            targetSha: newestFirst[0]!,
            selection: "first-parent",
            createdAt: now,
            count: newestFirst.length,
            digest: digestShas(newestFirst),
            commits: newestFirst.map(membership),
          },
          topics: built.topics,
        };
      } else {
        const sorted = [...shas].toSorted();
        op = {
          kind: "legacy",
          file: {
            schemaVersion: UPSTREAM_LEDGER_SCHEMA_VERSION,
            batch: snapshot.view.ledger.legacy.length + 1,
            createdAt: now,
            count: sorted.length,
            digest: digestShas(sorted),
            commits: sorted.map(membership),
          },
          topics: built.topics,
        };
      }
      yield* context
        .record(op, built.inboxCount)
        .pipe(Effect.mapError((error) => runFailure("record", describe(error))));
      snapshot = yield* context.currentView.pipe(
        Effect.mapError((error) => runFailure("base", describe(error))),
      );
      remainingAfter -= shas.length;
      yield* update({
        commitCount: run.commitCount + shas.length,
        inboxCount: run.inboxCount + built.inboxCount,
        autoDecidedCount: run.autoDecidedCount + built.autoDecidedCount,
        llmCalls: run.llmCalls + triaged.llmCalls,
        remainingCount: remainingAfter,
      });
      if (triaged.policyTruncated)
        yield* Effect.logWarning("upstreamPorts.run.policyTruncated", {
          projectId: initial.projectId,
        });
    }
    return remainingAfter > 0 ? "partial" : "succeeded";
  });

  return body.pipe(
    Effect.map(
      (status): RunRecord => ({ ...run, status, finishedAt: context.now().toISOString() }),
    ),
    Effect.catch((error) =>
      Effect.succeed<RunRecord>({
        ...run,
        status: "failed",
        failureKind: error instanceof RunFailure ? error.failureKind : "generic",
        errorMessage: truncateText(describe(error), 1_000),
        finishedAt: context.now().toISOString(),
      }),
    ),
    Effect.catchDefect((defect) =>
      Effect.succeed<RunRecord>({
        ...run,
        status: "failed",
        failureKind: "defect",
        errorMessage: truncateText(describe(defect), 1_000),
        finishedAt: context.now().toISOString(),
      }),
    ),
  );
}
