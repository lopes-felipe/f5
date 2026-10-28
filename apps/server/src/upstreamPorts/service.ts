/**
 * Upstream Ports service: per-project ledger view, decisions, triage runs,
 * the scheduler, the ledger publisher and port admission. Built in
 * `createServer` with a narrow host, like the Agent Bridge.
 *
 * @module upstreamPorts/service
 */
import { realpath } from "node:fs/promises";
import { hostname as osHostname, tmpdir } from "node:os";
import path from "node:path";

import {
  BOOTSTRAP_THREAD_DELETED_ERROR_CODE,
  BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE,
  CommandId,
  UpstreamPortsSettings,
  UpstreamTriageBatchResult,
  type ModelSelection,
  type NextTurnQueueSubmitInput,
  type OrchestrationReadModel,
  type ProjectCheckedInConfig,
  type ProjectId,
  type ServerProvider,
  type ServerSettings,
  type TurnSubmissionResult,
  type UpstreamAcceptSuggestionsInput,
  type UpstreamDecideInput,
  type UpstreamDecideResult,
  type UpstreamDecision,
  type UpstreamGetPortPromptInput,
  type UpstreamGetPortPromptResult,
  type UpstreamGetTopicInput,
  type UpstreamListTopicIdsInput,
  type UpstreamListTopicIdsResult,
  type UpstreamListTopicsInput,
  type UpstreamListTopicsResult,
  type UpstreamOverview,
  type UpstreamPortLinkSummary,
  type UpstreamPortsChanged,
  type UpstreamPortsListProjectsResult,
  type UpstreamProjectConfig,
  type UpstreamResolvePublicationInput,
  type UpstreamRevisionResult,
  type UpstreamRunInput,
  type UpstreamRunResult,
  type UpstreamRunTrigger,
  type UpstreamStartPortInput,
  type UpstreamStartPortResult,
  type UpstreamPreviewPortGroupsInput,
  type UpstreamPreviewPortGroupsResult,
  type UpstreamEnqueuePortInput,
  type UpstreamEnqueuePortResult,
  type UpstreamGetPortQueueInput,
  type UpstreamGetPortQueueResult,
  type UpstreamDequeuePortInput,
  type UpstreamControlPortQueueInput,
  type UpstreamPortQueueTarget,
  type UsageAccount,
  UPSTREAM_MAX_PORT_TOPICS,
  UPSTREAM_MAX_PORT_GROUPS,
  type UpstreamTopic,
  type UpstreamTopicDetail,
  type UpstreamTopicFiles,
  type UpstreamTopicRow,
  type UpstreamUndoDecisionsInput,
  type UpstreamUnlinkPortInput,
  UPSTREAM_MAX_FILES_COMMITS,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { setupProjectScript } from "@t3tools/shared/projectScripts";
import {
  ARCHIVE_PATH,
  canonicalJson,
  coverageTarget,
  EMPTY_LEDGER,
  isLedgerStatePath,
  localDate,
  parseLedgerFiles,
  parseRules,
  pickDecisionFields,
  POLICY_PATH,
  RULES_PATH,
  type DecisionFields,
  type Rules,
  type UpstreamLedger,
  type UpstreamLedgerOp,
} from "@t3tools/shared/upstreamPorts";
import {
  archiveContext,
  parseArchive,
  remainingLegacyShas,
  type Schema6Archive,
} from "@t3tools/shared/upstreamPortsArchive";
import {
  buildPortPrompt,
  parseUpstreamOutcomes,
  outcomeForTopic,
  decisionFromOutcome,
  type ParsedUpstreamOutcomes,
} from "@t3tools/shared/upstreamPortsPrompts";
import {
  filesOverlap,
  groupPortTopics,
  normalizeArea,
  portFileKeys,
  type PortGroupingTopic,
} from "@t3tools/shared/upstreamPortsGrouping";
import { Data, Effect, Exit, Schema, Scope, Semaphore } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeBackgroundWorker } from "../backgroundWorker.ts";
import { canonicalJsonHash } from "../canonicalJsonHash.ts";
import { isProviderUsable } from "../agentBridge/threadTools.ts";
import { hasActiveThreadTurn } from "../nextTurnQueue/gate.ts";
import { hasFreshUsageCapacity, scheduledUsageRetryAt } from "../usage/usageGate.ts";
import { makeQueueStore, type QueueRecord, type QueueState } from "./queueStore.ts";

import { GitCommandError, type TextGenerationError } from "../git/Errors.ts";
import type { StructuredJsonGenerationInput } from "../git/Services/TextGeneration.ts";
import { supportsNoWorkspaceIsolation } from "../git/Layers/TextGenerationLive.ts";
import {
  AdmissionError,
  buildPortCommand,
  groupTopicIds,
  portArgsHash,
  portBranchName,
  portSubmissionId,
  portThreadTitle,
} from "./admission.ts";
import { decisionFields, DecisionError, suggestionDecision } from "./decisions.ts";
import type { CommitNumstat, UpstreamGit } from "./git.ts";
import { parseGitHubRepo, type UpstreamGitHub } from "./github.ts";
import {
  BASE_FETCH_MIN_INTERVAL_MS,
  PUBLISH_DEBOUNCE_MS,
  PUBLISH_INTERVAL_MS,
  publishStep,
  unparsedLedgerMessage,
} from "./publisher.ts";
import { runTriage, runRetriage, type ViewSnapshot } from "./runs.ts";
import {
  applyRunResult,
  lastDueAt,
  newOccurrence,
  nextDueAt,
  occurrenceIsDue,
  SCHEDULER_TICK_MS,
} from "./scheduler.ts";
import {
  DEFAULT_PUBLICATION,
  type PortGroupRecord,
  type RunRecord,
  type UpstreamStore,
} from "./store.ts";
import type { TriageCall } from "./triage.ts";
import {
  buildTopicFiles,
  buildTopicHistory,
  buildView,
  countStates,
  deriveRows,
  EMPTY_TRAILERS,
  indexTrailers,
  listTopicIds as selectTopicIds,
  pageRows,
  selectRows,
  revisionOf,
  type DerivedRow,
  type LedgerView,
  type SubjectsOf,
  type TrailerIndex,
} from "./view.ts";
import {
  describeWriterClaim,
  ensureWriterClaim,
  readWriterClaim,
  isSameWriter,
  takeOverWriterClaim,
  writerClaimPath,
  type WriterIdentity,
} from "./writerClaim.ts";

export class UpstreamPortsError extends Data.TaggedError("UpstreamPortsError")<{
  readonly message: string;
  readonly code:
    | "not-found"
    | "invalid"
    | "conflict"
    | "read-only"
    | "unavailable"
    | "busy"
    | "internal";
}> {}

const fail = (code: UpstreamPortsError["code"], message: string) =>
  Effect.fail(new UpstreamPortsError({ code, message }));

const describe = (error: unknown) =>
  Schema.is(GitCommandError)(error)
    ? error.detail
    : error instanceof Error
      ? error.message
      : String(error);

/** Git could not find a commit, as opposed to timing out or failing otherwise. */
const isMissingObject = (error: GitCommandError) =>
  /bad object|bad revision|unknown revision|invalid object|not a valid object/iu.test(error.detail);

const internal = (error: unknown) =>
  error instanceof UpstreamPortsError
    ? error
    : new UpstreamPortsError({ code: "internal", message: describe(error) });

export interface UpstreamPortsHost {
  readonly usageAccounts?: Effect.Effect<ReadonlyArray<UsageAccount>, Error>;
  readonly readModel: Effect.Effect<OrchestrationReadModel, Error>;
  readonly checkedInConfig: (projectId: ProjectId) => Effect.Effect<ProjectCheckedInConfig, Error>;
  readonly getSettings: Effect.Effect<ServerSettings, Error>;
  readonly listProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly submitTurn: (
    body: NextTurnQueueSubmitInput,
  ) => Effect.Effect<
    TurnSubmissionResult | null,
    { readonly message: string; readonly code?: string }
  >;
  readonly publish: (payload: UpstreamPortsChanged) => Effect.Effect<void>;
  /** `TextGeneration.generateStructuredJson` with the triage output schema. */
  readonly generateTriageBatch:
    | ((
        input: Omit<
          StructuredJsonGenerationInput<typeof UpstreamTriageBatchResult>,
          "outputSchema"
        >,
      ) => Effect.Effect<typeof UpstreamTriageBatchResult.Type, TextGenerationError>)
    | null;
  readonly readDefaultBranch: (cwd: string) => Effect.Effect<string | null, Error>;
  readonly resolveAvailableBranchName: (cwd: string, name: string) => Effect.Effect<string, Error>;
  readonly resolveCommonDir: (cwd: string) => Effect.Effect<string, Error>;
  /** Cross-profile repository lock (`withRepositoryLifecycleLock`). */
  readonly withRepositoryLock: <A, E>(
    commonDir: string,
    mode: "user" | "background",
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | Error>;
}

export interface UpstreamPortsDeps {
  readonly host: UpstreamPortsHost;
  readonly store: UpstreamStore;
  readonly sql: SqlClient.SqlClient;
  readonly git: UpstreamGit;
  readonly github: UpstreamGitHub | null;
  readonly baseDir: string;
  readonly writer: Omit<WriterIdentity, "hostname"> & { readonly hostname?: string };
  readonly now?: () => Date;
  readonly mintId?: () => string;
  readonly runLimits?: Parameters<typeof runTriage>[0]["limits"];
}

interface ProjectContext {
  readonly projectId: string;
  readonly title: string;
  readonly cwd: string;
  readonly scripts: OrchestrationReadModel["projects"][number]["scripts"];
  readonly config: UpstreamProjectConfig | null;
  readonly diagnostics: ReadonlyArray<string>;
  readonly settings: UpstreamPortsSettings;
  readonly textGenerationModelSelection: ModelSelection | null;
}

interface BaseState {
  readonly baseBranch: string;
  readonly baseSha: string | null;
  readonly ledger: UpstreamLedger;
  readonly rules: Rules | null;
  readonly policy: string;
  readonly archive: Schema6Archive | null;
  readonly trailers: TrailerIndex;
  readonly errors: ReadonlyArray<string>;
  /** Repo-relative ledger files that failed to decode and are missing from `ledger`. */
  readonly unparsed: ReadonlyArray<string>;
}

const decodeSettings = Schema.decodeUnknownSync(UpstreamPortsSettings);

/**
 * Decision fields without the timestamp, to detect no-op decisions. The author
 * stays in, so confirming an automatic decision records it as the user's.
 */
const decisionSignature = (fields: DecisionFields) => {
  const { decidedAt: _at, ...rest } = fields;
  return canonicalJson(rest);
};

export const UNDO_TOKENS_PER_PROJECT = 20;
export const UNDO_TTL_MS = 15 * 60_000;

/** One user action, however many batches it took. */
interface UndoRecord {
  readonly token: string;
  readonly expiresAt: number;
  readonly entries: ReadonlyArray<{
    readonly topicId: string;
    readonly before: DecisionFields;
    /** `undoKey` of the decision's fields. */
    readonly after: string;
  }>;
}

/**
 * What an undo checks is still in place. The timestamp is in, so a later
 * decision that repeats the same values does not make an old token valid
 * again. The epoch is out: undo never lowers it, so an undone reopen leaves
 * the earlier decision at a higher epoch but otherwise intact.
 */
const undoKey = (fields: DecisionFields) => {
  const { epoch: _epoch, ...rest } = fields;
  return canonicalJson(rest);
};

export interface UpstreamPortsService {
  readonly previewPortGroups: (
    input: UpstreamPreviewPortGroupsInput,
  ) => Effect.Effect<UpstreamPreviewPortGroupsResult, UpstreamPortsError>;
  readonly enqueuePort: (
    input: UpstreamEnqueuePortInput,
  ) => Effect.Effect<UpstreamEnqueuePortResult, UpstreamPortsError>;
  readonly getPortQueue: (
    input: UpstreamGetPortQueueInput,
  ) => Effect.Effect<UpstreamGetPortQueueResult, UpstreamPortsError>;
  readonly dequeuePort: (
    input: UpstreamDequeuePortInput,
  ) => Effect.Effect<UpstreamRevisionResult, UpstreamPortsError>;
  readonly controlPortQueue: (
    input: UpstreamControlPortQueueInput,
  ) => Effect.Effect<UpstreamRevisionResult, UpstreamPortsError>;
  readonly wakePortQueue: (projectId?: string, threadId?: string) => Effect.Effect<void>;
  readonly listProjects: Effect.Effect<UpstreamPortsListProjectsResult, UpstreamPortsError>;
  readonly getOverview: (
    projectId: ProjectId,
  ) => Effect.Effect<UpstreamOverview, UpstreamPortsError>;
  readonly listTopics: (
    input: UpstreamListTopicsInput,
  ) => Effect.Effect<UpstreamListTopicsResult, UpstreamPortsError>;
  readonly listTopicIds: (
    input: UpstreamListTopicIdsInput,
  ) => Effect.Effect<UpstreamListTopicIdsResult, UpstreamPortsError>;
  readonly getTopic: (
    input: UpstreamGetTopicInput,
  ) => Effect.Effect<UpstreamTopicDetail, UpstreamPortsError>;
  readonly decide: (
    input: UpstreamDecideInput,
  ) => Effect.Effect<UpstreamDecideResult, UpstreamPortsError>;
  readonly acceptSuggestions: (
    input: UpstreamAcceptSuggestionsInput,
  ) => Effect.Effect<UpstreamDecideResult, UpstreamPortsError>;
  readonly undoDecisions: (
    input: UpstreamUndoDecisionsInput,
  ) => Effect.Effect<UpstreamDecideResult, UpstreamPortsError>;
  readonly getTopicFiles: (
    input: UpstreamGetTopicInput,
  ) => Effect.Effect<UpstreamTopicFiles, UpstreamPortsError>;
  readonly run: (
    input: UpstreamRunInput & { readonly trigger?: UpstreamRunTrigger },
  ) => Effect.Effect<UpstreamRunResult, UpstreamPortsError>;
  readonly startPort: (
    input: UpstreamStartPortInput,
  ) => Effect.Effect<UpstreamStartPortResult, UpstreamPortsError>;
  readonly unlinkPort: (
    input: UpstreamUnlinkPortInput,
  ) => Effect.Effect<UpstreamRevisionResult, UpstreamPortsError>;
  readonly getPortPrompt: (
    input: UpstreamGetPortPromptInput,
  ) => Effect.Effect<UpstreamGetPortPromptResult, UpstreamPortsError>;
  readonly resolvePublication: (
    input: UpstreamResolvePublicationInput,
  ) => Effect.Effect<UpstreamRevisionResult, UpstreamPortsError>;
  readonly addRemote: (
    projectId: ProjectId,
  ) => Effect.Effect<UpstreamRevisionResult, UpstreamPortsError>;
  readonly takeOverWriter: (
    projectId: ProjectId,
  ) => Effect.Effect<UpstreamRevisionResult, UpstreamPortsError>;
  /** Startup recovery plus the scheduler and publisher loops; runs in the given scope. */
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  /** Test hooks. */
  readonly testing: {
    readonly dispatchQueue: (projectId: string) => Effect.Effect<void>;
    readonly schedulerTick: Effect.Effect<void>;
    readonly publishNow: (projectId: string) => Effect.Effect<void>;
    readonly awaitIdle: Effect.Effect<void>;
  };
}

export function makeUpstreamPortsService(
  deps: UpstreamPortsDeps,
): Effect.Effect<UpstreamPortsService, never, Scope.Scope> {
  return Effect.gen(function* () {
    const { host, store, git } = deps;
    const queue = makeQueueStore(deps.sql);
    const portLocks = new Map<string, Semaphore.Semaphore>();
    const withPortLock = <A, E>(projectId: string, effect: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        let lock = portLocks.get(projectId);
        if (!lock) {
          lock = Semaphore.makeUnsafe(1);
          portLocks.set(projectId, lock);
        }
        return yield* lock.withPermits(1)(effect);
      });
    const now = deps.now ?? (() => new Date());
    const mintId = deps.mintId ?? (() => crypto.randomUUID());
    const today = () => localDate(now());
    const me: WriterIdentity = { ...deps.writer, hostname: deps.writer.hostname ?? osHostname() };
    const serviceScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(serviceScope, Exit.void));

    const baseCache = new Map<string, BaseState>();
    const lastBaseFetch = new Map<string, number>();
    const viewCache = new Map<string, { readonly key: string; readonly view: LedgerView }>();
    const activeRuns = new Set<string>();
    const inflight = new Set<Promise<unknown>>();
    const publishDue = new Map<string, number>();
    const publishing = new Set<string>();
    const commonDirs = new Map<string, string>();
    /** Newest last per project; tokens are single-use and in memory only. */
    const undoTokens = new Map<string, UndoRecord[]>();
    const pathsAtBase = new Map<
      string,
      { readonly baseSha: string; readonly paths: Set<string> }
    >();

    const track = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        let resolve!: () => void;
        const done = new Promise<void>((r) => (resolve = r));
        inflight.add(done);
        yield* effect.pipe(
          Effect.ignoreCause({ log: true }),
          Effect.ensuring(
            Effect.sync(() => {
              inflight.delete(done);
              resolve();
            }),
          ),
          Effect.forkIn(serviceScope),
        );
      });

    const emit = (
      projectId: string,
      reason: UpstreamPortsChanged["reason"],
      newInboxCount?: number,
    ) =>
      host
        .publish({
          projectId: projectId as ProjectId,
          reason,
          ...(newInboxCount !== undefined ? { newInboxCount } : {}),
        })
        .pipe(Effect.ignore);

    // ── Project context ──

    const resolveContext = (projectId: string) =>
      Effect.gen(function* () {
        const model = yield* host.readModel.pipe(Effect.mapError(internal));
        const project = model.projects.find(
          (entry) => entry.id === projectId && entry.deletedAt === null,
        );
        if (!project) return yield* fail("not-found", "Project not found.");
        const checkedIn = yield* host
          .checkedInConfig(project.id)
          .pipe(Effect.orElseSucceed(() => null as ProjectCheckedInConfig | null));
        const global = yield* host.getSettings.pipe(Effect.mapError(internal));
        const resolved = resolveProjectSettings({
          global,
          projectId: project.id,
          ...(checkedIn?.settings ? { checkedIn: checkedIn.settings } : {}),
          sourceFile: checkedIn?.sourceFile ?? null,
        }).settings;
        return {
          projectId: project.id,
          title: project.title,
          cwd: project.workspaceRoot,
          scripts: project.scripts,
          config: checkedIn?.upstream ?? null,
          diagnostics: (checkedIn?.diagnostics ?? [])
            .filter((entry) => entry.field === "upstream")
            .map((entry) => entry.message),
          settings: decodeSettings(resolved.upstreamPorts ?? {}),
          textGenerationModelSelection: resolved.textGenerationModelSelection ?? null,
        } satisfies ProjectContext;
      });

    const requireConfig = (context: ProjectContext) =>
      context.config
        ? Effect.succeed(context.config)
        : fail("invalid", "This project has no upstream block in f5.json.");

    const commonDirFor = (cwd: string) =>
      Effect.gen(function* () {
        const cached = commonDirs.get(cwd);
        if (cached) return cached;
        const raw = yield* host.resolveCommonDir(cwd).pipe(Effect.mapError(internal));
        const resolved = yield* Effect.tryPromise({
          try: () => realpath(path.resolve(cwd, raw)),
          catch: internal,
        });
        commonDirs.set(cwd, resolved);
        return resolved;
      });

    const claimFile = (cwd: string) =>
      commonDirFor(cwd).pipe(Effect.map((dir) => writerClaimPath(deps.baseDir, dir)));
    const claimIo = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (error) =>
          new UpstreamPortsError({
            code: "unavailable",
            message: `The upstream writer claim is unavailable: ${describe(error)}`,
          }),
      });

    const isWriter = (cwd: string) =>
      claimFile(cwd).pipe(
        Effect.flatMap((file) => claimIo(() => readWriterClaim(file))),
        Effect.map((claim) => claim !== null && isSameWriter(claim, me)),
        Effect.orElseSucceed(() => false),
      );

    /** Claims an unclaimed repository; fails read-only when another profile holds it. */
    const requireWriter = (cwd: string) =>
      Effect.gen(function* () {
        const file = yield* claimFile(cwd);
        const mine = yield* claimIo(() => ensureWriterClaim(file, me, now().toISOString()));
        if (!mine) {
          const claim = yield* claimIo(() => readWriterClaim(file));
          return yield* fail(
            "read-only",
            `Managed by profile ${claim?.profileId ?? "unknown"}${claim?.hostname ? ` on ${claim.hostname}` : ""}.`,
          );
        }
      });

    const withLock = <A, E>(
      cwd: string,
      mode: "user" | "background",
      effect: Effect.Effect<A, E>,
    ) =>
      Effect.gen(function* () {
        const dir = yield* commonDirFor(cwd);
        return yield* host.withRepositoryLock(dir, mode, effect);
      }).pipe(
        Effect.mapError((error) =>
          error instanceof UpstreamPortsError
            ? error
            : /busy/iu.test(describe(error))
              ? new UpstreamPortsError({ code: "busy", message: describe(error) })
              : internal(error),
        ),
      );

    // ── Base ledger and view ──

    const loadBase = (
      context: ProjectContext,
      options: { readonly fetch: boolean; readonly refresh?: boolean },
    ) =>
      Effect.gen(function* () {
        const config = yield* requireConfig(context);
        const baseBranch =
          (yield* host.readDefaultBranch(context.cwd).pipe(Effect.orElseSucceed(() => null))) ??
          "main";
        if (options.fetch) {
          const last = lastBaseFetch.get(context.projectId) ?? 0;
          if (options.refresh || now().getTime() - last >= BASE_FETCH_MIN_INTERVAL_MS) {
            yield* git
              .fetchBranch(context.cwd, "origin", baseBranch)
              .pipe(Effect.mapError(internal));
            lastBaseFetch.set(context.projectId, now().getTime());
          }
        }
        const baseSha = yield* git
          .revParse(context.cwd, `refs/remotes/origin/${baseBranch}`)
          .pipe(Effect.mapError(internal));
        const cached = baseCache.get(context.projectId);
        if (cached && cached.baseSha === baseSha && cached.baseBranch === baseBranch) return cached;
        if (baseSha === null) {
          const empty: BaseState = {
            baseBranch,
            baseSha,
            ledger: EMPTY_LEDGER,
            rules: null,
            policy: "",
            archive: null,
            trailers: EMPTY_TRAILERS,
            errors: [`origin/${baseBranch} is missing; fetch the repository first.`],
            unparsed: [],
          };
          baseCache.set(context.projectId, empty);
          return empty;
        }
        const prefix = `${config.ledgerDir}/`;
        const files = yield* git
          .readFilesAtRef({ cwd: context.cwd, ref: baseSha, pathPrefixes: [config.ledgerDir] })
          .pipe(Effect.mapError(internal));
        const state = new Map<string, string>();
        for (const [file, text] of files)
          if (file.startsWith(prefix) && isLedgerStatePath(file.slice(prefix.length)))
            state.set(file.slice(prefix.length), text);
        const parsed = parseLedgerFiles(state);
        const errors = [...parsed.errors];
        const rulesText = files.get(`${prefix}${RULES_PATH}`);
        const rules = rulesText === undefined ? null : parseRules(rulesText);
        if (rulesText === undefined) errors.push(`${prefix}${RULES_PATH} is missing.`);
        else if (rules?.errors.length) errors.push(...rules.errors);
        let archive: Schema6Archive | null = cached?.archive ?? null;
        const archiveText = files.get(`${prefix}${ARCHIVE_PATH}`);
        if (archiveText !== undefined && archive === null) {
          const parsedArchive = yield* Effect.try({
            try: () => parseArchive(archiveText),
            catch: (error) => new UpstreamPortsError({ code: "invalid", message: describe(error) }),
          }).pipe(Effect.result);
          if (parsedArchive._tag === "Success") archive = parsedArchive.success;
          else errors.push(`${prefix}${ARCHIVE_PATH}: ${parsedArchive.failure.message}`);
        }
        const trailers = indexTrailers(
          yield* git.trailerCommits(context.cwd, baseSha).pipe(Effect.orElseSucceed(() => [])),
        );
        const next: BaseState = {
          baseBranch,
          baseSha,
          ledger: parsed.ledger,
          rules: rules && rules.errors.length === 0 ? rules.rules : null,
          policy: files.get(`${prefix}${POLICY_PATH}`) ?? "",
          archive,
          trailers,
          errors,
          unparsed: parsed.unparsed.map((file) => `${prefix}${file}`),
        };
        baseCache.set(context.projectId, next);
        viewCache.delete(context.projectId);
        return next;
      });

    /** Commit subjects per topic, so list search also finds a topic by its commits. */
    const subjectsOf =
      (snapshot: { readonly view: LedgerView }): SubjectsOf =>
      (topicId) =>
        (snapshot.view.members.get(topicId) ?? []).map((member) => member.subject);

    const currentView = (
      context: ProjectContext,
      options: { readonly fetch: boolean } = { fetch: false },
    ) =>
      Effect.gen(function* () {
        const base = yield* loadBase(context, options);
        const maxSeq = yield* store.maxSeq(context.projectId).pipe(Effect.mapError(internal));
        const key = `${base.baseSha}:${maxSeq}`;
        const cached = viewCache.get(context.projectId);
        let view: LedgerView;
        if (cached?.key === key) view = cached.view;
        else {
          const open = yield* store.listOpenOps(context.projectId).pipe(Effect.mapError(internal));
          view = buildView(base.baseSha, base.ledger, open);
          viewCache.set(context.projectId, { key, view });
        }
        const links = yield* store.listLinks(context.projectId).pipe(Effect.mapError(internal));
        const publication = yield* store
          .getPublication(context.projectId)
          .pipe(Effect.mapError(internal));
        const rows = deriveRows(view, base.trailers, links, today());
        const revision = revisionOf({
          baseSha: base.baseSha,
          maxSeq,
          linksVersion: publication.linksVersion,
          today: today(),
        });
        const contentRevision = revisionOf({
          baseSha: base.baseSha,
          maxSeq,
          linksVersion: 0,
          today: today(),
        });
        return { base, view, rows, links, publication, revision, contentRevision, maxSeq };
      });
    type CurrentView = Effect.Success<ReturnType<typeof currentView>>;

    /** Recording over a partial ledger would drop or rewrite the files that failed to parse. */
    const requireParsedLedger = (base: BaseState) =>
      base.unparsed.length === 0
        ? Effect.void
        : fail("unavailable", unparsedLedgerMessage(base.baseBranch, base.unparsed));

    const requireRules = (base: BaseState) =>
      base.rules
        ? Effect.succeed(base.rules)
        : fail("unavailable", base.errors[0] ?? "The ledger rules are unavailable.");

    // ── Recording ──

    /**
     * Records the ops `plan` picks from the view read under the repository
     * lock, after the writer check, so a decision recorded meanwhile is seen;
     * pushes `ledger-updated`.
     */
    const recordPlanned = <A>(
      context: ProjectContext,
      mode: "user" | "background",
      plan: (snapshot: CurrentView) => {
        readonly ops: ReadonlyArray<UpstreamLedgerOp>;
        readonly result: A;
      },
      newInbox?: number,
    ) =>
      Effect.gen(function* () {
        const planned = yield* withLock(
          context.cwd,
          mode,
          Effect.gen(function* () {
            yield* requireWriter(context.cwd);
            const snapshot = yield* currentView(context);
            yield* requireParsedLedger(snapshot.base);
            const { ops, result } = yield* Effect.try({
              try: () => plan(snapshot),
              catch: internal,
            });
            if (ops.length === 0) return { recorded: false, result };
            const check = buildView(
              snapshot.base.baseSha,
              snapshot.view.ledger,
              ops.map((op, index) => ({
                opId: `check-${index}`,
                projectId: context.projectId,
                seq: index,
                op,
                state: "recorded" as const,
                createdAt: "",
              })),
            );
            if (check.conflicts.length) return yield* fail("conflict", check.conflicts[0]!);
            yield* store
              .recordOps(
                context.projectId,
                ops.map((op) => ({ opId: mintId(), op })),
                now().toISOString(),
              )
              .pipe(Effect.mapError(internal));
            return { recorded: true, result };
          }),
        );
        if (planned.recorded) {
          viewCache.delete(context.projectId);
          yield* emit(context.projectId, "ledger-updated", newInbox);
          schedulePublish(context.projectId, PUBLISH_DEBOUNCE_MS);
        }
        return planned.result;
      });

    /** Records ops under the repository lock after the writer check; pushes `ledger-updated`. */
    const recordOps = (
      context: ProjectContext,
      ops: ReadonlyArray<UpstreamLedgerOp>,
      mode: "user" | "background",
      newInbox?: number,
    ) =>
      ops.length === 0
        ? Effect.void
        : recordPlanned(context, mode, () => ({ ops, result: undefined }), newInbox);

    // ── Publisher ──

    function schedulePublish(projectId: string, delayMs: number) {
      const at = now().getTime() + delayMs;
      const existing = publishDue.get(projectId);
      if (existing === undefined || at < existing) publishDue.set(projectId, at);
    }

    const publishFor = (projectId: string, force?: "retry" | "republish") =>
      Effect.gen(function* () {
        if (publishing.has(projectId)) return;
        publishing.add(projectId);
        yield* Effect.gen(function* () {
          const context = yield* resolveContext(projectId);
          const config = yield* requireConfig(context);
          const baseBranch =
            (yield* host.readDefaultBranch(context.cwd).pipe(Effect.orElseSucceed(() => null))) ??
            "main";
          const originUrl = yield* git
            .remoteUrl(context.cwd, "origin")
            .pipe(Effect.orElseSucceed(() => null));
          const outcome = yield* publishStep(
            {
              projectId,
              cwd: context.cwd,
              repository: config.repository,
              remote: config.remote,
              baseBranch,
              ledgerDir: config.ledgerDir,
              githubRepo: originUrl ? parseGitHubRepo(originUrl) : null,
              git,
              github: deps.github,
              store,
              now,
              today,
              loadBase: ({ refresh }) =>
                loadBase(context, { fetch: true, refresh }).pipe(
                  Effect.map((base) => ({
                    baseSha: base.baseSha,
                    ledger: base.ledger,
                    unparsed: base.unparsed,
                  })),
                ),
              deriveRows: (view) =>
                Effect.gen(function* () {
                  const base = baseCache.get(projectId);
                  const links = yield* store
                    .listLinks(projectId)
                    .pipe(Effect.orElseSucceed(() => []));
                  return deriveRows(view, base?.trailers ?? EMPTY_TRAILERS, links, today());
                }),
              isWriter: isWriter(context.cwd),
              resolveBranchName: (name) => host.resolveAvailableBranchName(context.cwd, name),
            },
            force ? { force } : {},
          ).pipe(Effect.mapError(internal));
          viewCache.delete(projectId);
          if (outcome.kind === "retry-later") schedulePublish(projectId, outcome.delayMs);
          if (outcome.kind === "published" && outcome.again) schedulePublish(projectId, 0);
          yield* emit(projectId, "publication-updated");
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("upstreamPorts.publish.failed", {
              projectId,
              detail: describe(error),
            }),
          ),
          Effect.ensuring(Effect.sync(() => publishing.delete(projectId))),
        );
      });

    const publisherLoop = Effect.gen(function* () {
      let lastSweep = 0;
      while (true) {
        const nowMs = now().getTime();
        if (nowMs - lastSweep >= PUBLISH_INTERVAL_MS) {
          lastSweep = nowMs;
          const projects = yield* projectsWithOpenOps.pipe(
            Effect.orElseSucceed(() => [] as string[]),
          );
          for (const projectId of projects) schedulePublish(projectId, 0);
        }
        for (const [projectId, at] of publishDue) {
          if (at > nowMs || publishing.has(projectId)) continue;
          publishDue.delete(projectId);
          yield* track(publishFor(projectId));
        }
        yield* Effect.sleep("2 seconds");
      }
    });

    const projectsWithOpenOps = deps.sql<{ readonly project_id: string }>`
      SELECT DISTINCT project_id FROM upstream_ledger_ops WHERE state = 'recorded'`.pipe(
      Effect.map((rows) => rows.map((row) => row.project_id)),
    );

    // ── Triage model ──

    const resolveTriageModel = (context: ProjectContext) =>
      Effect.gen(function* () {
        const providers = yield* host.listProviders;
        const usable = (selection: ModelSelection | null) => {
          if (!selection) return null;
          const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
          return provider &&
            provider.enabled &&
            provider.installed &&
            supportsNoWorkspaceIsolation(provider.driver)
            ? selection
            : null;
        };
        const fromSetting = usable(context.settings.triageModelSelection);
        if (fromSetting) return fromSetting;
        const fromProject = usable(context.textGenerationModelSelection);
        if (fromProject) return fromProject;
        const claude = providers.find(
          (entry) =>
            entry.enabled &&
            entry.installed &&
            supportsNoWorkspaceIsolation(entry.driver) &&
            entry.models.length > 0,
        );
        return claude
          ? ({ instanceId: claude.instanceId, model: claude.models[0]!.slug } as ModelSelection)
          : null;
      });

    const triageCallFor = (selection: ModelSelection): TriageCall | null => {
      const generate = host.generateTriageBatch;
      if (!generate) return null;
      return (prompt) =>
        generate({
          cwd: tmpdir(),
          operation: "upstreamTriage",
          prompt,
          modelSelection: selection,
          isolation: "no-workspace",
        });
    };

    // ── Remote ──

    const remoteStatus = (context: ProjectContext, config: UpstreamProjectConfig) =>
      Effect.gen(function* () {
        const url = yield* git
          .remoteUrl(context.cwd, config.remote)
          .pipe(Effect.orElseSucceed(() => null));
        if (url === null) return { status: "missing" as const, url };
        const actual = parseGitHubRepo(url);
        const wanted = parseGitHubRepo(config.repository);
        const match =
          actual !== null &&
          wanted !== null &&
          actual.owner.toLowerCase() === wanted.owner.toLowerCase() &&
          actual.name.toLowerCase() === wanted.name.toLowerCase();
        return { status: match ? ("ok" as const) : ("mismatch" as const), url };
      });

    // ── Runs ──

    const finishScheduled = (run: RunRecord) =>
      Effect.gen(function* () {
        if (run.occurrenceDueAt === null) return;
        const occurrence = yield* store.getOccurrence(run.projectId, run.occurrenceDueAt);
        if (!occurrence) return;
        yield* store.saveOccurrence(applyRunResult(occurrence, run, now()));
      });

    const startRun = (
      context: ProjectContext,
      input: {
        readonly kind: RunRecord["kind"];
        readonly triage: RunRecord["triage"];
        readonly trigger: UpstreamRunTrigger;
        readonly occurrenceDueAt?: string;
      },
    ) =>
      Effect.gen(function* () {
        const config = yield* requireConfig(context);
        yield* requireWriter(context.cwd);
        if (input.kind === "retriage" && (input.triage !== "llm" || input.trigger !== "manual"))
          return yield* fail("invalid", "Re-triage requires a manual LLM run.");
        if (activeRuns.has(context.projectId))
          return yield* fail("busy", "A run is already in progress for this project.");
        // Reserve before anything yields, so a double click or a racing scheduler
        // tick cannot start a second run. The forked run releases it when it ends.
        activeRuns.add(context.projectId);
        return yield* Effect.gen(function* () {
          const active = yield* store.activeRun(context.projectId).pipe(Effect.mapError(internal));
          if (active) return yield* fail("busy", "A run is already in progress for this project.");
          if (input.kind !== "legacy") {
            const remote = yield* remoteStatus(context, config);
            if (remote.status !== "ok")
              return yield* fail(
                "invalid",
                remote.status === "missing"
                  ? `The ${config.remote} remote is missing; add it first.`
                  : `The ${config.remote} remote points at ${remote.url}, not ${config.repository}.`,
              );
          }
          let triage: TriageCall | null = null;
          let model = "rules";
          if (input.triage === "llm") {
            const selection = yield* resolveTriageModel(context);
            triage = selection ? triageCallFor(selection) : null;
            if (!selection || !triage)
              return yield* fail(
                "unavailable",
                "No Claude instance is available for triage. Run rules only instead.",
              );
            model = selection.model;
          }
          const snapshot = yield* currentView(context);
          yield* requireParsedLedger(snapshot.base);
          const rules = yield* requireRules(snapshot.base);
          const runId = mintId();
          const record: RunRecord = {
            runId,
            projectId: context.projectId,
            kind: input.kind,
            trigger: input.trigger,
            triage: input.triage,
            occurrenceDueAt: input.occurrenceDueAt ?? null,
            status: "running",
            startedAt: now().toISOString(),
            finishedAt: null,
            failureKind: null,
            targetSha: null,
            commitCount: 0,
            inboxCount: 0,
            autoDecidedCount: 0,
            remainingCount: 0,
            llmCalls: 0,
            errorMessage: null,
          };
          yield* store.insertRun(record).pipe(Effect.mapError(internal));
          if (record.occurrenceDueAt) {
            const occurrence = yield* store
              .getOccurrence(context.projectId, record.occurrenceDueAt)
              .pipe(Effect.orElseSucceed(() => null));
            if (occurrence)
              yield* store
                .saveOccurrence({ ...occurrence, status: "running", lastRunId: runId })
                .pipe(Effect.ignore);
          }
          yield* emit(context.projectId, "run-started");
          const prBodies =
            deps.github && parseGitHubRepo(config.repository)
              ? (numbers: ReadonlyArray<number>) =>
                  deps.github!.fetchPullRequestBodies({
                    cwd: context.cwd,
                    repo: parseGitHubRepo(config.repository)!,
                    numbers,
                  })
              : null;
          const viewSnapshot = (fetch: boolean) =>
            currentView(context, { fetch }).pipe(
              Effect.map((value): ViewSnapshot => ({ view: value.view, rows: value.rows })),
            );
          const work = (input.kind === "retriage" ? runRetriage : runTriage)(
            {
              cwd: context.cwd,
              config,
              baseBranch: snapshot.base.baseBranch,
              git,
              prBodies,
              rules,
              policy: snapshot.base.policy,
              archive: snapshot.base.archive,
              triage,
              model,
              now,
              today,
              refreshView: viewSnapshot(true),
              currentView: viewSnapshot(false),
              record: (op, newInbox) => recordOps(context, [op], "background", newInbox),
              recordRetriage: (entries) =>
                recordPlanned(context, "background", (fresh) => {
                  const ops: UpstreamLedgerOp[] = [];
                  for (const entry of entries) {
                    const row = fresh.rows.find((row) => row.topic.id === entry.topicId);
                    if (!row || row.topic.epoch !== entry.epoch) continue;
                    ops.push({
                      kind: "suggestion",
                      topicId: entry.topicId,
                      title: entry.title,
                      summary: entry.summary,
                      ...(entry.suggestion ? { suggestion: entry.suggestion } : {}),
                    });
                    if (entry.decision && row.state === "inbox" && row.topic.status === "inbox")
                      ops.push({
                        kind: "decision",
                        topicId: entry.topicId,
                        fields: decisionFields(
                          row.topic,
                          {
                            kind: "skip",
                            reasonKey: entry.decision.reasonKey,
                            reason: entry.decision.reason,
                          },
                          {
                            rules,
                            state: row.state,
                            now: now().toISOString(),
                            today: today(),
                            baseSha: fresh.base.baseSha,
                            decidedBy: entry.decision.decidedBy,
                          },
                        ),
                      });
                  }
                  return { ops, result: undefined };
                }),
              progress: (run) => store.updateRun(run).pipe(Effect.ignore),
              ...(deps.runLimits ? { limits: deps.runLimits } : {}),
            },
            record,
          ).pipe(
            Effect.tap((finished) =>
              Effect.gen(function* () {
                yield* store.updateRun(finished).pipe(Effect.ignore);
                yield* finishScheduled(finished).pipe(Effect.ignore);
                yield* emit(
                  context.projectId,
                  "run-finished",
                  finished.kind === "retriage" ? undefined : finished.inboxCount,
                );
                schedulePublish(context.projectId, 0);
              }),
            ),
            Effect.ensuring(Effect.sync(() => activeRuns.delete(context.projectId))),
          );
          yield* track(work);
          return { runId };
        }).pipe(Effect.onError(() => Effect.sync(() => activeRuns.delete(context.projectId))));
      });

    // ── Scheduler ──

    const schedulerTick = Effect.gen(function* () {
      const model = yield* host.readModel.pipe(Effect.orElseSucceed(() => null));
      if (!model) return;
      for (const project of model.projects) {
        if (project.deletedAt !== null) continue;
        yield* Effect.gen(function* () {
          const context = yield* resolveContext(project.id);
          if (!context.config || context.settings.schedule.mode === "off") return;
          const file = yield* claimFile(context.cwd);
          if (!(yield* claimIo(() => ensureWriterClaim(file, me, now().toISOString())))) return;
          const due = lastDueAt(context.settings.schedule, now());
          if (!due) return;
          const dueAt = due.toISOString();
          yield* store.supersedeOccurrencesBefore(project.id, dueAt);
          let occurrence = yield* store.getOccurrence(project.id, dueAt);
          if (!occurrence) {
            occurrence = newOccurrence(project.id, dueAt);
            yield* store.saveOccurrence(occurrence);
          }
          if (occurrence.status === "pending" || occurrence.status === "running") {
            const succeeded = yield* store.latestSucceededUpstreamRunSince(project.id, dueAt);
            if (succeeded) {
              yield* store.saveOccurrence({
                ...occurrence,
                status: "succeeded",
                lastRunId: succeeded.runId,
                nextAttemptAt: null,
              });
              return;
            }
          }
          if (!occurrenceIsDue(occurrence, now()) || activeRuns.has(project.id)) return;
          yield* startRun(context, {
            kind: "upstream",
            triage: "llm",
            trigger: occurrence.continuations > 0 ? "continuation" : "schedule",
            occurrenceDueAt: dueAt,
          }).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                if (error instanceof UpstreamPortsError && error.code === "busy") return;
                // A run that cannot start counts as a failed attempt.
                yield* store.saveOccurrence(
                  applyRunResult(
                    occurrence!,
                    { runId: "", status: "failed", errorMessage: describe(error) },
                    now(),
                  ),
                );
              }),
            ),
          );
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("upstreamPorts.scheduler.project.failed", {
              projectId: project.id,
              detail: describe(error),
            }),
          ),
        );
      }
    });

    // ── Ports ──

    /** Only the assistant message owned by the settled turn can supply an outcome. */
    const readOutcomes = (
      context: ProjectContext,
      model: OrchestrationReadModel | null,
      threadIds: ReadonlyArray<string>,
    ) =>
      Effect.gen(function* () {
        const ids = new Set(threadIds);
        const turns =
          model?.threads.filter(
            (thread) =>
              ids.has(thread.id) &&
              thread.latestTurn?.state === "completed" &&
              thread.latestTurn.processingQuiescedAt != null &&
              thread.latestTurn.assistantMessageId != null,
          ) ?? [];
        const messageIds = turns.map((thread) => thread.latestTurn!.assistantMessageId!);
        if (!messageIds.length) return new Map<string, ParsedUpstreamOutcomes>();
        const messages = messageIds.length
          ? yield* deps.sql<{ message_id: string; text: string }>`
          SELECT message_id,text FROM projection_thread_messages WHERE role = 'assistant'
          AND ${deps.sql.in("message_id", messageIds)}`
          : [];
        const forkRepo = yield* git
          .remoteUrl(context.cwd, "origin")
          .pipe(Effect.orElseSucceed(() => null));
        return new Map(
          turns.flatMap((thread) => {
            const message = messages.find(
              (entry) => entry.message_id === thread.latestTurn!.assistantMessageId,
            );
            return message
              ? [[thread.id as string, parseUpstreamOutcomes(message.text, { forkRepo })] as const]
              : [];
          }),
        );
      });

    const linkSummaries = (
      context: ProjectContext,
      threadIds: ReadonlyArray<string>,
      model: OrchestrationReadModel | null,
      cachedOutcomes?: ReadonlyMap<string, ParsedUpstreamOutcomes>,
    ) =>
      Effect.gen(function* () {
        const unique = [...new Set(threadIds)];
        if (unique.length === 0) return new Map<string, Omit<UpstreamPortLinkSummary, "epoch">>();
        const outcomes = cachedOutcomes ?? (yield* readOutcomes(context, model, unique));
        const prs = yield* deps.sql<{
          readonly thread_id: string;
          readonly number: number;
          readonly url: string;
        }>`
          SELECT thread_id, number, url FROM projection_thread_pull_requests
          WHERE ${deps.sql.in("thread_id", unique)} ORDER BY updated_at DESC`.pipe(
          Effect.orElseSucceed(() => []),
        );
        const out = new Map<string, Omit<UpstreamPortLinkSummary, "epoch">>();
        for (const threadId of unique) {
          const thread = model?.threads.find((entry) => entry.id === threadId) ?? null;
          const pr = prs.find((entry) => entry.thread_id === threadId);
          const outcome = outcomes.get(threadId)?.thread ?? null;
          const outcomePr = outcome?.kind === "pr" ? outcome.detail : null;
          out.set(threadId, {
            threadId: threadId as UpstreamPortLinkSummary["threadId"],
            threadTitle: thread?.title ?? null,
            threadStatus: thread
              ? thread.archivedAt
                ? "archived"
                : (thread.latestTurn?.state ?? "idle")
              : null,
            branch: thread?.branch ?? null,
            prNumber: pr
              ? Number(pr.number)
              : outcomePr
                ? Number(outcomePr.split("/").at(-1))
                : null,
            prUrl: pr?.url ?? outcomePr,
            prState: null,
            outcome,
          });
        }
        return out;
      });

    const toRows = (
      context: ProjectContext,
      rows: ReadonlyArray<DerivedRow>,
      links: ReadonlyArray<{
        readonly topicId: string;
        readonly epoch: number;
        readonly threadId: string;
        readonly state: string;
      }>,
    ) =>
      Effect.gen(function* () {
        const active = links.filter((link) => link.state === "active");
        const ids = new Set(rows.map((row) => row.topic.id));
        const relevant = active.filter((link) => ids.has(link.topicId));
        const model = relevant.length
          ? yield* host.readModel.pipe(Effect.orElseSucceed(() => null))
          : null;
        const outcomes = relevant.length
          ? yield* readOutcomes(
              context,
              model,
              relevant.map((link) => link.threadId),
            ).pipe(Effect.orElseSucceed(() => new Map<string, ParsedUpstreamOutcomes>()))
          : new Map();
        const summaries = yield* linkSummaries(
          context,
          relevant.map((link) => link.threadId),
          model,
          outcomes,
        );
        const queued = yield* queue.listQueuedTopicIds(context.projectId);
        return rows.map(
          (row): UpstreamTopicRow => ({
            topic: row.topic,
            queued: queued.has(row.topic.id),
            state: row.state,
            commitCount: row.commitCount,
            doneBy: row.doneBy,
            links: relevant
              .filter((link) => link.topicId === row.topic.id && link.epoch === row.topic.epoch)
              .map((link) => ({
                ...summaries.get(link.threadId)!,
                epoch: link.epoch,
                outcome: outcomes.has(link.threadId)
                  ? outcomeForTopic(outcomes.get(link.threadId)!, row.topic.id)
                  : null,
              })),
          }),
        );
      });

    const portPrompt = (
      context: ProjectContext,
      config: UpstreamProjectConfig,
      snapshot: {
        readonly base: BaseState;
        readonly view: LedgerView;
        readonly rows: ReadonlyArray<DerivedRow>;
      },
      topics: ReadonlyArray<UpstreamTopic>,
    ) =>
      Effect.gen(function* () {
        const rowsById = new Map(snapshot.rows.map((row) => [row.topic.id, row]));
        const commitsFor = (topic: UpstreamTopic) =>
          (snapshot.view.members.get(topic.id) ?? []).map((member) => ({
            sha: member.sha,
            subject: member.subject,
          }));
        const shas = topics.flatMap((topic) => commitsFor(topic).map((commit) => commit.sha));
        const topicPaths = yield* git
          .topicPaths(context.cwd, shas)
          .pipe(Effect.orElseSucceed(() => []));
        const archiveCtx = snapshot.base.archive ? archiveContext(snapshot.base.archive) : null;
        return buildPortPrompt({
          repository: config.repository,
          remote: config.remote,
          branch: config.branch,
          ledgerDir: config.ledgerDir,
          base: snapshot.base.baseBranch,
          coverageTarget: coverageTarget(snapshot.view.ledger, archiveCtx) ?? "HEAD",
          policy: snapshot.base.policy,
          topics: topics.map((topic) => ({
            topic,
            commits: commitsFor(topic),
            related: (topic.relatedTopics ?? []).map((id) => ({
              id,
              title: rowsById.get(id)?.topic.title ?? id,
              state: rowsById.get(id)?.state ?? null,
            })),
          })),
          topicPaths,
        });
      });

    const isSettledRejection = (error: { readonly code?: string }) =>
      error.code === BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE ||
      error.code === BOOTSTRAP_THREAD_DELETED_ERROR_CODE;

    const submitGroup = (group: PortGroupRecord) =>
      Effect.gen(function* () {
        // Only a definitive no-agent isolation failure may expire. Ambiguous delivery
        // must keep its original identity and slot until reconciled.
        const admitted = group.clientRequestId.startsWith("queue:")
          ? yield* deps.sql<{ created_at: string }>`
              SELECT created_at FROM upstream_port_requests
              WHERE project_id = ${group.projectId} AND client_request_id = ${group.clientRequestId}`
          : [];
        const isolationRetryExpired =
          admitted[0] !== undefined &&
          now().getTime() - Date.parse(admitted[0].created_at) >= 120_000;
        const outcome = yield* host
          .submitTurn({
            submissionId: CommandId.makeUnsafe(group.submissionId),
            command: group.command as NextTurnQueueSubmitInput["command"],
            intent: "auto",
          })
          .pipe(
            Effect.map((result) =>
              result === null
                ? ({
                    status: "pending",
                    reason: "Provider delivery has not been confirmed.",
                  } as const)
                : result.disposition === "rejected" ||
                    result?.disposition === "canceled" ||
                    result?.disposition === "cleared"
                  ? ({ status: "rejected", reason: result.detail ?? result.reasonCode } as const)
                  : ({ status: "submitted", reason: null } as const),
            ),
            Effect.catch((error) =>
              Effect.succeed(
                isSettledRejection(error) &&
                  !(
                    group.clientRequestId.startsWith("queue:") &&
                    /worktree isolation unavailable/iu.test(error.message) &&
                    !isolationRetryExpired
                  )
                  ? ({ status: "rejected", reason: error.message } as const)
                  : ({ status: "pending", reason: error.message } as const),
              ),
            ),
          );
        if (outcome.status === "pending") {
          if (outcome.reason !== group.reason)
            yield* store.setGroupStatus(group, "pending", outcome.reason, now().toISOString());
          return { ...group, reason: outcome.reason };
        }
        yield* store.setGroupStatus(group, outcome.status, outcome.reason, now().toISOString());
        if (outcome.status === "rejected") {
          // The filter unlinks every topic in the group and bumps the links version once.
          yield* store.setLinkState(
            { projectId: group.projectId, topicId: group.topicIds[0]!, threadId: group.threadId },
            "unlinked",
            { clientRequestId: group.clientRequestId, groupIndex: group.groupIndex },
          );
        }
        return { ...group, status: outcome.status, reason: outcome.reason };
      });

    const reconcilePendingGroups = Effect.gen(function* () {
      const pending = yield* store.listPendingGroups;
      const touched = new Set<string>();
      for (const group of pending) {
        yield* Effect.gen(function* () {
          const context = yield* resolveContext(group.projectId);
          if (!(yield* isWriter(context.cwd))) return;
          const submitted = yield* submitGroup(group);
          if (submitted.status !== group.status || submitted.reason !== group.reason)
            touched.add(group.projectId);
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("upstreamPorts.reconcile.failed", { detail: describe(error) }),
          ),
        );
      }
      for (const projectId of touched) yield* emit(projectId, "links-updated");
    });

    // ── Decisions ──

    const applyDecisions = (
      input: {
        readonly projectId: ProjectId;
        readonly topicIds: ReadonlyArray<string>;
        readonly undoToken?: string | undefined;
      },
      decisionFor: (topic: UpstreamTopic) => UpstreamDecision | null,
    ) =>
      Effect.gen(function* () {
        const context = yield* resolveContext(input.projectId);
        yield* requireConfig(context);
        yield* requireWriter(context.cwd);
        const snapshot = yield* currentView(context);
        yield* requireParsedLedger(snapshot.base);
        const rules = yield* requireRules(snapshot.base);
        const rowsById = new Map(snapshot.rows.map((row) => [row.topic.id, row]));
        const ops: UpstreamLedgerOp[] = [];
        const updated: string[] = [];
        const unchanged: string[] = [];
        const undo: Array<UndoRecord["entries"][number]> = [];
        for (const topicId of new Set(input.topicIds)) {
          const row = rowsById.get(topicId);
          if (!row) return yield* fail("not-found", `Topic ${topicId} does not exist.`);
          const decision = decisionFor(row.topic);
          if (!decision) {
            unchanged.push(topicId);
            continue;
          }
          const fields = yield* Effect.try({
            try: () =>
              decisionFields(row.topic, decision, {
                rules,
                state: row.state,
                now: now().toISOString(),
                today: today(),
                baseSha: snapshot.base.baseSha,
              }),
            catch: (error) =>
              new UpstreamPortsError({
                code: "invalid",
                message: error instanceof DecisionError ? error.message : describe(error),
              }),
          });
          const before = pickDecisionFields(row.topic);
          if (decisionSignature(fields) === decisionSignature(before)) {
            unchanged.push(topicId);
            continue;
          }
          ops.push({ kind: "decision", topicId, fields });
          updated.push(topicId);
          undo.push({ topicId, before, after: undoKey(fields) });
        }
        yield* recordOps(context, ops, "user");
        const after = yield* currentView(context);
        const result: UpstreamDecideResult = {
          revision: after.revision,
          updated,
          unchanged,
          undoToken: saveUndo(context.projectId, undo, input.undoToken),
        };
        return result;
      });

    /**
     * Keeps `entries` for undo. Passing the token of an earlier batch of the
     * same action adds them to it, so the action stays one token however many
     * batches it took and cannot evict its own first batches.
     */
    const saveUndo = (projectId: string, entries: UndoRecord["entries"], join?: string) => {
      const at = now().getTime();
      const live = (undoTokens.get(projectId) ?? []).filter((record) => record.expiresAt > at);
      const joined = join === undefined ? undefined : live.find((record) => record.token === join);
      if (joined) {
        if (entries.length > 0)
          undoTokens.set(
            projectId,
            live.map((record) =>
              record === joined ? { ...joined, entries: [...joined.entries, ...entries] } : record,
            ),
          );
        return joined.token;
      }
      if (entries.length === 0) return null;
      const token = mintId();
      live.push({ token, expiresAt: at + UNDO_TTL_MS, entries });
      undoTokens.set(projectId, live.slice(-UNDO_TOKENS_PER_PROJECT));
      return token;
    };

    /** Removes the token so it works once; `undefined` when it is unknown or expired. */
    const takeUndo = (projectId: string, token: string) => {
      const records = undoTokens.get(projectId) ?? [];
      const record = records.find((entry) => entry.token === token);
      if (record)
        undoTokens.set(
          projectId,
          records.filter((entry) => entry !== record),
        );
      return record && record.expiresAt > now().getTime() ? record : undefined;
    };

    /** Puts back a token whose undo failed before recording anything. */
    const returnUndo = (projectId: string, record: UndoRecord) =>
      Effect.sync(() => {
        const records = undoTokens.get(projectId) ?? [];
        undoTokens.set(
          projectId,
          [...records, record]
            .toSorted((left, right) => left.expiresAt - right.expiresAt)
            .slice(-UNDO_TOKENS_PER_PROJECT),
        );
      });

    /**
     * Restores each topic's fields from before the decision, timestamp
     * included. Topics decided again since, or now in progress, stay as they
     * are. The epoch never goes back: a reopen may already be in the ledger
     * pull request, and a lower epoch would conflict with it once merged.
     */
    const applyUndo = (input: UpstreamUndoDecisionsInput) =>
      Effect.gen(function* () {
        const context = yield* resolveContext(input.projectId);
        yield* requireConfig(context);
        yield* requireWriter(context.cwd);
        const record = takeUndo(context.projectId, input.undoToken);
        if (!record) return yield* fail("not-found", "This undo has expired.");
        return yield* restoreDecisions(context, record).pipe(
          Effect.tapError(() => returnUndo(context.projectId, record)),
        );
      });

    const restoreDecisions = (context: ProjectContext, record: UndoRecord) =>
      Effect.gen(function* () {
        // Eligibility is read under the lock, so a decision recorded meanwhile is not overwritten.
        const restored = yield* recordPlanned(context, "user", (snapshot) => {
          const rowsById = new Map(snapshot.rows.map((row) => [row.topic.id, row]));
          const ops: UpstreamLedgerOp[] = [];
          const topicIds = new Set<string>();
          // Newest entry first: within one action a topic is decided at most once, but stay safe.
          for (const entry of record.entries.toReversed()) {
            const row = rowsById.get(entry.topicId);
            if (!row || topicIds.has(entry.topicId)) continue;
            if (undoKey(pickDecisionFields(row.topic)) !== entry.after) continue;
            const linked = snapshot.links.some(
              (link) =>
                link.topicId === entry.topicId &&
                link.state === "active" &&
                link.epoch === row.topic.epoch,
            );
            if (linked) continue;
            const fields = {
              ...entry.before,
              epoch: Math.max(entry.before.epoch, row.topic.epoch),
            };
            ops.push({ kind: "decision", topicId: entry.topicId, fields });
            topicIds.add(entry.topicId);
          }
          return { ops, result: topicIds };
        });
        const after = yield* currentView(context);
        const result: UpstreamDecideResult = {
          revision: after.revision,
          updated: [...restored],
          unchanged: [
            ...new Set(
              record.entries
                .map((entry) => entry.topicId)
                .filter((topicId) => !restored.has(topicId)),
            ),
          ],
          undoToken: null,
        };
        return result;
      });

    // ── RPC ──

    const getOverview: UpstreamPortsService["getOverview"] = (projectId) =>
      Effect.gen(function* () {
        const context = yield* resolveContext(projectId);
        const claim = yield* claimFile(context.cwd).pipe(
          Effect.flatMap((file) => claimIo(() => describeWriterClaim(file, me))),
          Effect.orElseSucceed(() => ({
            claimed: false,
            managedByThisProfile: false,
            profileId: null,
            hostname: null,
            claimedAt: null,
          })),
        );
        const publication = yield* store.getPublication(projectId).pipe(Effect.mapError(internal));
        const schedule = context.settings.schedule;
        const empty: UpstreamOverview = {
          projectId,
          revision: "none",
          config: context.config,
          diagnostics: context.diagnostics,
          remoteStatus: "missing",
          remoteUrl: null,
          writer: claim as UpstreamOverview["writer"],
          activeRun: null,
          lastRun: null,
          schedule,
          nextRunAt: null,
          occurrence: null,
          publication: {
            branch: publication.branch,
            prNumber: publication.prNumber,
            prUrl: publication.prUrl,
            prState: publication.prState,
            phase: publication.phase,
            pausedReason: publication.pausedReason,
            lastError: publication.lastError,
            unpublishedOps: 0,
          },
          counts: { inbox: 0, ready: 0, "in-progress": 0, watch: 0, done: 0, skipped: 0 },
          trackedThrough: null,
          legacyRemaining: 0,
          triageFailedCount: 0,
          portQueue: {
            queuedTopics: 0,
            queuedThreads: 0,
            running: 0,
            concurrency: context.settings.portConcurrency,
            waitingOnFiles: 0,
            paused: false,
            pausedReason: null,
            hold: null,
          },
          untriagedUpstreamCount: 0,
          ghAvailable: false,
          triageModelAvailable: false,
          policyTruncated: false,
          autoSkipConfidence: 1,
          reasonKeys: [],
          reasonLabels: {},
          upstreamOnlySubsystems: [],
        };
        if (!context.config) return empty;
        const config = context.config;
        const snapshot = yield* currentView(context);
        const remote = yield* remoteStatus(context, config);
        const archiveCtx = snapshot.base.archive ? archiveContext(snapshot.base.archive) : null;
        const target = coverageTarget(snapshot.view.ledger, archiveCtx);
        const untriaged =
          target && remote.status === "ok"
            ? yield* git
                .countFirstParent(
                  context.cwd,
                  target,
                  `refs/remotes/${config.remote}/${config.branch}`,
                )
                .pipe(Effect.orElseSucceed(() => 0))
            : 0;
        const batched = new Set(
          snapshot.view.ledger.legacy.flatMap((file) => file.commits.map((commit) => commit.sha)),
        );
        const activeRun = yield* store.activeRun(projectId).pipe(Effect.mapError(internal));
        const lastRun = yield* store
          .latestRun(projectId, { finished: true })
          .pipe(Effect.mapError(internal));
        const occurrence = yield* store.latestOccurrence(projectId).pipe(Effect.mapError(internal));
        const nextRun = nextDueAt(schedule, now());
        const pendingNext =
          occurrence?.status === "pending" && occurrence.nextAttemptAt
            ? new Date(occurrence.nextAttemptAt)
            : null;
        const ghAvailable = deps.github
          ? yield* deps.github.available(context.cwd).pipe(Effect.orElseSucceed(() => false))
          : false;
        const triageModel = yield* resolveTriageModel(context);
        const rules = snapshot.base.rules;
        const strip = (run: RunRecord | null) => {
          if (!run) return null;
          const { projectId: _p, occurrenceDueAt: _o, ...summary } = run;
          return summary;
        };
        return {
          ...empty,
          revision: snapshot.revision,
          diagnostics: [
            ...context.diagnostics,
            ...snapshot.base.errors,
            ...snapshot.view.conflicts,
          ],
          remoteStatus: remote.status,
          remoteUrl: remote.url,
          activeRun: strip(activeRun),
          lastRun: strip(lastRun),
          nextRunAt:
            (pendingNext && (!nextRun || pendingNext < nextRun)
              ? pendingNext
              : nextRun
            )?.toISOString() ?? null,
          occurrence: occurrence
            ? {
                dueAt: occurrence.dueAt,
                status: occurrence.status,
                attempts: occurrence.attempts,
                continuations: occurrence.continuations,
                nextAttemptAt: occurrence.nextAttemptAt,
                lastError: occurrence.lastError,
              }
            : null,
          publication: { ...empty.publication, unpublishedOps: snapshot.view.openOps.length },
          counts: countStates(snapshot.rows),
          triageFailedCount: snapshot.rows.filter(
            (row) => row.state === "inbox" && row.topic.suggestion?.triageError,
          ).length,
          portQueue: yield* queueSummary(context, snapshot),
          trackedThrough: target,
          legacyRemaining: snapshot.base.archive
            ? remainingLegacyShas(snapshot.base.archive, batched).length
            : 0,
          untriagedUpstreamCount: untriaged,
          ghAvailable,
          triageModelAvailable: triageModel !== null && host.generateTriageBatch !== null,
          policyTruncated: new TextEncoder().encode(snapshot.base.policy).length > 16 * 1024,
          autoSkipConfidence: rules?.autoSkipConfidence ?? 1,
          reasonKeys: rules?.reasonKeys ?? [],
          reasonLabels: rules?.reasonLabels ?? {},
          upstreamOnlySubsystems: rules?.upstreamOnlySubsystems ?? [],
        } satisfies UpstreamOverview;
      }).pipe(Effect.mapError(internal));

    const listProjects: UpstreamPortsService["listProjects"] = Effect.gen(function* () {
      const model = yield* host.readModel.pipe(Effect.mapError(internal));
      const projects: Array<UpstreamPortsListProjectsResult["projects"][number]> = [];
      for (const project of model.projects) {
        if (project.deletedAt !== null) continue;
        const entry = yield* Effect.gen(function* () {
          const context = yield* resolveContext(project.id);
          if (!context.config) return null;
          const snapshot = yield* currentView(context).pipe(Effect.orElseSucceed(() => null));
          const managed = yield* isWriter(context.cwd);
          return {
            projectId: project.id,
            title: project.title,
            repository: context.config.repository,
            inboxCount: snapshot ? countStates(snapshot.rows).inbox : 0,
            managedByThisProfile: managed,
          };
        }).pipe(Effect.orElseSucceed(() => null));
        if (entry) projects.push(entry);
      }
      return { projects };
    });

    const listTopics: UpstreamPortsService["listTopics"] = (input) =>
      Effect.gen(function* () {
        const context = yield* resolveContext(input.projectId);
        yield* requireConfig(context);
        const snapshot = yield* currentView(context);
        const page = pageRows(snapshot.rows, input, snapshot.contentRevision, subjectsOf(snapshot));
        const topics = yield* toRows(context, page.rows, snapshot.links);
        return {
          revision: snapshot.revision,
          contentRevision: snapshot.contentRevision,
          status: page.status,
          nextCursor: page.nextCursor,
          total: page.total,
          facets: page.facets,
          topics,
        };
      }).pipe(Effect.mapError(internal));

    const listTopicIds: UpstreamPortsService["listTopicIds"] = (input) =>
      Effect.gen(function* () {
        const context = yield* resolveContext(input.projectId);
        yield* requireConfig(context);
        const snapshot = yield* currentView(context);
        const result = selectTopicIds(snapshot.rows, input, subjectsOf(snapshot));
        const ids: UpstreamListTopicIdsResult = {
          revision: snapshot.revision,
          contentRevision: snapshot.contentRevision,
          ...result,
        };
        return ids;
      }).pipe(Effect.mapError(internal));

    const getTopic: UpstreamPortsService["getTopic"] = (input) =>
      Effect.gen(function* () {
        const context = yield* resolveContext(input.projectId);
        const config = yield* requireConfig(context);
        const snapshot = yield* currentView(context);
        const row = snapshot.rows.find((entry) => entry.topic.id === input.topicId);
        if (!row) return yield* fail("not-found", `Topic ${input.topicId} does not exist.`);
        const [full] = yield* toRows(context, [row], snapshot.links);
        const rowsById = new Map(snapshot.rows.map((entry) => [entry.topic.id, entry]));
        const ops = yield* store
          .listTopicDecisionOps(context.projectId, row.topic.id)
          .pipe(Effect.mapError(internal));
        const history = buildTopicHistory({
          topic: row.topic,
          baseTopic: snapshot.view.base.topics.find((topic) => topic.id === row.topic.id),
          ops,
          links: snapshot.links,
        });
        return {
          revision: snapshot.revision,
          repository: config.repository,
          row: full!,
          members: [
            ...(snapshot.view.members.get(row.topic.id) ?? []),
          ] as UpstreamTopicDetail["members"],
          related: (row.topic.relatedTopics ?? []).map((id) => ({
            id,
            title: rowsById.get(id)?.topic.title ?? id,
            state: rowsById.get(id)?.state ?? null,
          })),
          history,
        } satisfies UpstreamTopicDetail;
      }).pipe(Effect.mapError(internal));

    /** Paths on origin/<base>, kept per base SHA; `null` when git cannot list them. */
    const basePaths = (context: ProjectContext, baseSha: string | null) =>
      Effect.gen(function* () {
        if (baseSha === null) return null;
        const cached = pathsAtBase.get(context.projectId);
        if (cached?.baseSha === baseSha) return cached.paths;
        const paths = yield* git
          .listPathsAtRef(context.cwd, baseSha)
          .pipe(Effect.orElseSucceed(() => null));
        if (paths) pathsAtBase.set(context.projectId, { baseSha, paths });
        return paths;
      });

    const getTopicFiles: UpstreamPortsService["getTopicFiles"] = (input) =>
      Effect.gen(function* () {
        const context = yield* resolveContext(input.projectId);
        yield* requireConfig(context);
        const snapshot = yield* currentView(context);
        if (!snapshot.view.topicsById.has(input.topicId))
          return yield* fail("not-found", `Topic ${input.topicId} does not exist.`);
        const members = (snapshot.view.members.get(input.topicId) ?? []).map(
          (member) => member.sha,
        );
        const shas = members.slice(0, UPSTREAM_MAX_FILES_COMMITS);
        // One missing commit fails the whole `git log`; retry one by one to find it.
        // Any other failure (a timeout, say) is reported rather than shown as missing commits.
        const numstat = yield* git
          .streamNumstat(context.cwd, { kind: "shas", shas })
          .pipe(
            Effect.catchIf(isMissingObject, () =>
              Effect.forEach(
                shas,
                (sha) =>
                  git
                    .streamNumstat(context.cwd, { kind: "shas", shas: [sha] })
                    .pipe(
                      Effect.catchIf(isMissingObject, () =>
                        Effect.succeed(new Map<string, CommitNumstat>()),
                      ),
                    ),
                { concurrency: 4 },
              ).pipe(Effect.map((maps) => new Map(maps.flatMap((map) => [...map])))),
            ),
          );
        const paths = yield* basePaths(context, snapshot.base.baseSha);
        return buildTopicFiles(shas, numstat, paths, members.length);
      }).pipe(Effect.mapError(internal));

    const decide: UpstreamPortsService["decide"] = (input) =>
      applyDecisions(input, () => input.decision).pipe(Effect.mapError(internal));

    const acceptSuggestions: UpstreamPortsService["acceptSuggestions"] = (input) =>
      applyDecisions(input, suggestionDecision).pipe(Effect.mapError(internal));

    const undoDecisions: UpstreamPortsService["undoDecisions"] = (input) =>
      applyUndo(input).pipe(Effect.mapError(internal));

    const run: UpstreamPortsService["run"] = (input) =>
      Effect.gen(function* () {
        const context = yield* resolveContext(input.projectId);
        return yield* startRun(context, {
          kind: input.kind,
          triage: input.triage,
          trigger: input.trigger ?? "manual",
        });
      }).pipe(Effect.mapError(internal));

    const fileSetsCache = new Map<
      string,
      {
        paths: ReadonlyArray<string> | null;
        expiresAt: number;
      }
    >();
    const topicFileSets = (
      context: ProjectContext,
      snapshot: CurrentView,
      topicIds: ReadonlyArray<string>,
    ) =>
      Effect.gen(function* () {
        const result = new Map<string, ReadonlyArray<string> | null>();
        const missing: Array<{ id: string; key: string; shas: string[] }> = [];
        for (const id of new Set(topicIds)) {
          const topic = snapshot.view.topicsById.get(id);
          if (!topic) continue;
          const key = `${context.projectId}:${id}:${topic.epoch}`;
          if ((fileSetsCache.get(key)?.expiresAt ?? 0) > now().getTime()) {
            const cached = fileSetsCache.get(key)!;
            fileSetsCache.delete(key);
            fileSetsCache.set(key, cached);
            result.set(id, cached.paths);
          } else
            missing.push({
              id,
              key,
              shas: (snapshot.view.members.get(id) ?? [])
                .slice(0, UPSTREAM_MAX_FILES_COMMITS)
                .map((member) => member.sha),
            });
        }
        const shas = [...new Set(missing.flatMap((entry) => entry.shas))];
        const stats = new Map<string, CommitNumstat>();
        for (let offset = 0; offset < shas.length; offset += 500) {
          const batch = shas.slice(offset, offset + 500);
          const values = yield* git
            .streamNumstat(context.cwd, { kind: "shas", shas: batch })
            .pipe(
              Effect.catchIf(isMissingObject, () =>
                Effect.forEach(
                  batch,
                  (sha) =>
                    git
                      .streamNumstat(context.cwd, { kind: "shas", shas: [sha] })
                      .pipe(
                        Effect.catchIf(isMissingObject, () =>
                          Effect.succeed(new Map<string, CommitNumstat>()),
                        ),
                      ),
                  { concurrency: 4 },
                ).pipe(Effect.map((maps) => new Map(maps.flatMap((map) => [...map])))),
              ),
            );
          for (const [sha, stat] of values) stats.set(sha, stat);
        }
        for (const entry of missing) {
          const available = entry.shas.filter((sha) => stats.has(sha));
          const paths = available.length
            ? [...new Set(available.flatMap((sha) => stats.get(sha)!.paths))]
            : null;
          result.set(entry.id, paths);
          // Negative/partial evidence is short lived: a fetch may restore missing objects.
          // Cache it too so repeated wakes and the two readers in a dispatch pass share it.
          fileSetsCache.set(entry.key, {
            paths,
            expiresAt:
              available.length === entry.shas.length && paths !== null
                ? Infinity
                : now().getTime() + 30_000,
          });
          while (fileSetsCache.size > 5_000)
            fileSetsCache.delete(fileSetsCache.keys().next().value!);
        }
        return result;
      });
    const groupingTopics = (
      snapshot: CurrentView,
      ids: ReadonlyArray<string>,
      keys: ReadonlyMap<string, ReadonlyArray<string> | null>,
    ): PortGroupingTopic[] =>
      ids.flatMap((id) => {
        const topic = snapshot.view.topicsById.get(id);
        return topic
          ? [
              {
                id,
                area: normalizeArea(topic.suggestion?.areas[0] ?? ""),
                related: topic.relatedTopics ?? [],
                fileKeys: keys.get(id) ?? null,
              },
            ]
          : [];
      });

    const startPortImpl = (input: UpstreamStartPortInput, queued?: QueueRecord) =>
      Effect.gen(function* () {
        const context = yield* resolveContext(input.projectId);
        const config = yield* requireConfig(context);
        yield* requireWriter(context.cwd);
        const argsHash = portArgsHash(input);
        let groups = yield* store
          .listGroups(context.projectId, input.clientRequestId)
          .pipe(Effect.mapError(internal));
        const existing = yield* store
          .getPortRequest(context.projectId, input.clientRequestId)
          .pipe(Effect.mapError(internal));
        if (existing && existing.argsHash !== argsHash)
          return yield* fail(
            "conflict",
            "That clientRequestId was already used with different arguments.",
          );
        if (!existing) {
          const snapshot = yield* currentView(context);
          const rowsById = new Map(snapshot.rows.map((row) => [row.topic.id, row]));
          for (const topicId of input.topicIds) {
            const row = rowsById.get(topicId);
            if (!row) return yield* fail("not-found", `Topic ${topicId} does not exist.`);
            if (row.state !== "ready" && row.state !== "in-progress")
              return yield* fail("invalid", `Topic ${topicId} is ${row.state}; decide Port first.`);
          }
          const grouped = yield* Effect.try({
            try: () =>
              groupTopicIds(input.topicIds, input.grouping, {
                batchSize: input.batchSize,
                maxGroups: UPSTREAM_MAX_PORT_GROUPS,
              }),
            catch: (error) => new UpstreamPortsError({ code: "invalid", message: describe(error) }),
          });
          if (input.topicIds.length > UPSTREAM_MAX_PORT_TOPICS)
            return yield* fail("invalid", "Start at most 20 topics at once.");
          if (input.grouping === "batched") {
            const keys = portFileKeys(
              yield* topicFileSets(context, snapshot, input.topicIds),
            ).keysByTopic;
            grouped.splice(
              0,
              grouped.length,
              ...groupTopicIds(groupingTopics(snapshot, input.topicIds, keys), input.grouping, {
                batchSize: input.batchSize,
                maxGroups: UPSTREAM_MAX_PORT_GROUPS,
              }),
            );
          }
          const providers = yield* host.listProviders;
          const provider = providers.find(
            (entry) => entry.instanceId === input.modelSelection.instanceId,
          );
          if (!provider || !provider.enabled)
            return yield* fail("unavailable", "The selected provider instance is unavailable.");
          const baseBranch = snapshot.base.baseBranch;
          const createdAt = now().toISOString();
          const runSetupScript = setupProjectScript(context.scripts) !== null;
          const built: Array<
            Omit<PortGroupRecord, "projectId" | "clientRequestId" | "status" | "reason"> & {
              epochs: Array<{ topicId: string; epoch: number }>;
            }
          > = [];
          for (const [groupIndex, ids] of grouped.entries()) {
            const topics = ids.map((id) => rowsById.get(id)!.topic);
            const branch = yield* host
              .resolveAvailableBranchName(context.cwd, portBranchName(ids))
              .pipe(Effect.mapError(internal));
            const prompt = yield* portPrompt(context, config, snapshot, topics);
            const threadId = mintId();
            const submissionId = portSubmissionId(input.clientRequestId, groupIndex);
            const title = portThreadTitle(topics);
            built.push({
              groupIndex,
              threadId,
              submissionId,
              topicIds: ids,
              command: buildPortCommand({
                projectId: context.projectId,
                projectCwd: context.cwd,
                threadId,
                messageId: mintId(),
                submissionId,
                title,
                prompt,
                baseBranch,
                branch,
                runSetupScript,
                modelSelection: input.modelSelection,
                driver: provider.driver,
                runtimeMode: input.runtimeMode,
                createdAt,
                requireWorktree: queued !== undefined,
              }),
              epochs: topics.map((topic) => ({ topicId: topic.id, epoch: topic.epoch })),
            });
          }
          // File evidence is loaded before either lock; a newly linked unknown topic makes reservation stale.
          const evidence = queued
            ? portFileKeys(
                yield* topicFileSets(
                  context,
                  snapshot,
                  snapshot.links
                    .filter((link) => link.state === "active")
                    .map((link) => link.topicId),
                ),
                { dropHotPaths: false },
              ).keysByTopic
            : new Map<string, ReadonlyArray<string> | null>();
          const inserted = yield* withPortLock(
            context.projectId,
            withLock(
              context.cwd,
              queued ? "background" : "user",
              Effect.gen(function* () {
                const racedRequest = yield* store.getPortRequest(
                  context.projectId,
                  input.clientRequestId,
                );
                if (racedRequest) {
                  if (racedRequest.argsHash !== argsHash)
                    return yield* fail(
                      "conflict",
                      "That clientRequestId was already used with different arguments.",
                    );
                  return false;
                }
                const fresh = yield* currentView(context);
                for (const id of input.topicIds) {
                  const before = rowsById.get(id)!;
                  const after = fresh.rows.find((row) => row.topic.id === id);
                  if (
                    !after ||
                    after.topic.epoch !== before.topic.epoch ||
                    after.state !== before.state ||
                    canonicalJson(
                      fresh.links.filter((link) => link.topicId === id && link.state === "active"),
                    ) !==
                      canonicalJson(
                        snapshot.links.filter(
                          (link) => link.topicId === id && link.state === "active",
                        ),
                      )
                  )
                    return yield* fail("conflict", "Topics changed; reopen Start port.");
                }
                let reservedEntry = queued;
                if (queued) {
                  const entry = (yield* queue.listQueue(context.projectId)).find(
                    (entry) => entry.entryId === queued.entryId,
                  );
                  reservedEntry = entry;
                  const state = yield* queue.getQueueState(context.projectId);
                  const settings = (yield* resolveContext(context.projectId)).settings;
                  if (
                    !entry ||
                    entry.status !== "queued" ||
                    canonicalJson(entry.topicIds) !== canonicalJson(queued.topicIds) ||
                    state.paused ||
                    state.holdKind ||
                    (yield* runningThreads(context.projectId, fresh)).size >=
                      settings.portConcurrency
                  )
                    return yield* fail("conflict", "Queue changed before reservation.");
                  if (
                    !entry.ignoreConflicts &&
                    (yield* conflictLinks(context, fresh)).some((link) => {
                      return (
                        snapshot.view.topicsById.get(link.topicId)?.epoch !== link.epoch ||
                        !evidence.has(link.topicId) ||
                        filesOverlap(entry.fileKeys, evidence.get(link.topicId) ?? [])
                      );
                    })
                  )
                    return yield* fail("conflict", "File conflicts changed before reservation.");
                }
                return yield* deps.sql.withTransaction(
                  Effect.gen(function* () {
                    const inserted = yield* store.insertPortRequest({
                      projectId: context.projectId,
                      clientRequestId: input.clientRequestId,
                      argsHash,
                      groups: built.map(({ epochs: _epochs, ...group }) => group),
                      links: built.flatMap((group) =>
                        group.epochs.map((entry) => ({
                          ...entry,
                          threadId: group.threadId,
                          groupIndex: group.groupIndex,
                        })),
                      ),
                      at: createdAt,
                    });
                    if (reservedEntry)
                      yield* queue.setQueueEntry({
                        ...reservedEntry,
                        status: "started",
                        threadId: built[0]!.threadId,
                        updatedAt: createdAt,
                      });
                    yield* queue.removeTopicsFromQueued(
                      context.projectId,
                      input.topicIds,
                      createdAt,
                    );
                    return inserted;
                  }),
                );
              }),
            ),
          ).pipe(Effect.mapError(internal));
          if (!inserted) {
            const raced = yield* store
              .getPortRequest(context.projectId, input.clientRequestId)
              .pipe(Effect.mapError(internal));
            if (raced && raced.argsHash !== argsHash)
              return yield* fail(
                "conflict",
                "That clientRequestId was already used with different arguments.",
              );
          }
          groups = yield* store
            .listGroups(context.projectId, input.clientRequestId)
            .pipe(Effect.mapError(internal));
          yield* emit(context.projectId, "links-updated");
        }
        const results = [];
        for (const group of groups)
          results.push(
            group.status === "pending"
              ? yield* submitGroup(group).pipe(Effect.mapError(internal))
              : group,
          );
        yield* emit(context.projectId, "links-updated");
        return {
          groups: results.map((group) => ({
            threadId: group.threadId as UpstreamStartPortResult["groups"][number]["threadId"],
            topicIds: group.topicIds as UpstreamStartPortResult["groups"][number]["topicIds"],
            status: group.status,
            reason: group.reason,
          })),
        };
      }).pipe(
        Effect.mapError((error) =>
          error instanceof AdmissionError
            ? new UpstreamPortsError({ code: error.code, message: error.message })
            : internal(error),
        ),
      );

    const startPort: UpstreamPortsService["startPort"] = (input) => startPortImpl(input);

    const runningThreads = (projectId: string, snapshot: CurrentView) =>
      Effect.gen(function* () {
        const model = yield* host.readModel;
        const links = snapshot.links.filter(
          (link) =>
            link.state === "active" &&
            snapshot.view.topicsById.get(link.topicId)?.epoch === link.epoch,
        );
        const owned = (yield* queue.listQueue(projectId)).filter(
          (entry) =>
            entry.status === "started" &&
            entry.threadId !== null &&
            entry.topicIds.some(
              (id) => snapshot.view.topicsById.get(id)?.epoch === entry.topicEpochs[id],
            ),
        );
        const ids = [
          ...new Set([
            ...links.map((link) => link.threadId),
            ...owned.map((entry) => entry.threadId!),
          ]),
        ];
        const running = new Set<string>();
        if (!ids.length) return running;
        const blocked = yield* deps.sql<{ thread_id: string }>`
        SELECT thread_id FROM next_turn_queue WHERE deleted_at IS NULL AND status IN ('queued','dispatching') AND ${deps.sql.in("thread_id", ids)}
        UNION SELECT thread_id FROM projection_pending_approvals WHERE status = 'pending' AND ${deps.sql.in("thread_id", ids)}
        UNION SELECT thread_id FROM projection_turns WHERE state IN ('pending','running') AND ${deps.sql.in("thread_id", ids)}
        UNION SELECT thread_id FROM provider_turn_deliveries WHERE reservation_released_at IS NULL
          AND state IN ('pending','sending','accepted','ambiguous') AND ${deps.sql.in("thread_id", ids)}
        UNION SELECT thread_id FROM upstream_port_groups WHERE project_id = ${projectId} AND status = 'pending'`;
        const blockers = new Set(blocked.map((row) => row.thread_id));
        const groupTimes = yield* deps.sql<{
          thread_id: string;
          updated_at: string;
          status: string;
        }>`
        SELECT thread_id,updated_at,status FROM upstream_port_groups WHERE project_id = ${projectId}`;
        for (const id of ids) {
          const thread = model.threads.find(
            (thread) => thread.id === id && thread.deletedAt === null,
          );
          const group = groupTimes.find((group) => group.thread_id === id);
          if (
            blockers.has(id) ||
            (thread &&
              (hasActiveThreadTurn(
                thread.latestTurn?.state === "running" ? thread.latestTurn : null,
                thread.session,
              ) ||
                (thread.pendingUserInputs?.length ?? 0) > 0 ||
                (thread.latestTurn != null && thread.latestTurn.processingQuiescedAt == null))) ||
            (!thread &&
              group?.status !== "rejected" &&
              now().getTime() -
                Date.parse(
                  group?.updated_at ??
                    owned.find((entry) => entry.threadId === id)?.updatedAt ??
                    now().toISOString(),
                ) <
                120_000)
          )
            running.add(id);
        }
        return running;
      });

    const resolveTarget = (snapshot: CurrentView, target: UpstreamPortQueueTarget): string[] =>
      target.kind === "ids"
        ? [...new Set(target.topicIds)]
        : selectRows(
            snapshot.rows,
            { list: "ready", filter: target.filter, sort: target.sort },
            subjectsOf(snapshot),
          ).map(({ row }) => row.topic.id);
    const queueSkips = (
      snapshot: CurrentView,
      ids: ReadonlyArray<string>,
      queued: ReadonlySet<string>,
    ) => {
      const rows = new Map(snapshot.rows.map((row) => [row.topic.id, row]));
      return ids.flatMap((topicId): UpstreamEnqueuePortResult["skipped"][number][] => {
        const row = rows.get(topicId);
        const reason = !row
          ? "unknown"
          : queued.has(topicId)
            ? "already-queued"
            : row.state !== "ready"
              ? "not-ready"
              : null;
        return reason ? [{ topicId, reason }] : [];
      });
    };
    const previewPortGroups: UpstreamPortsService["previewPortGroups"] = (input) =>
      Effect.gen(function* () {
        const context = yield* resolveContext(input.projectId);
        yield* requireConfig(context);
        const snapshot = yield* currentView(context);
        const ids = resolveTarget(snapshot, input.target);
        const keys = portFileKeys(yield* topicFileSets(context, snapshot, ids)).keysByTopic;
        const topics = groupingTopics(snapshot, ids, keys);
        const groups = groupPortTopics(topics, input.grouping, input.batchSize);
        const skipped = queueSkips(snapshot, ids, yield* queue.listQueuedTopicIds(input.projectId));
        const byId = new Map(topics.map((topic) => [topic.id, topic]));
        return {
          topicCount: topics.length,
          threadCount: groups.length,
          fileLinkedThreads: groups.filter((group) =>
            group.some((id, index) =>
              group
                .slice(index + 1)
                .some(
                  (other) =>
                    filesOverlap(byId.get(id)!.fileKeys ?? [], byId.get(other)!.fileKeys ?? []) ||
                    byId.get(id)!.related.includes(other) ||
                    byId.get(other)!.related.includes(id),
                ),
            ),
          ).length,
          filesUnknown: topics.filter((topic) => topic.fileKeys === null).length,
          queueable: ids.length - skipped.length,
          skipped,
        };
      }).pipe(Effect.mapError(internal));

    const enqueuePort: UpstreamPortsService["enqueuePort"] = (input) =>
      Effect.gen(function* () {
        const context = yield* resolveContext(input.projectId);
        yield* requireConfig(context);
        yield* requireWriter(context.cwd);
        const argsHash = canonicalJsonHash(input);
        const replay = yield* queue.getEnqueueRequest(input.projectId, input.clientRequestId);
        if (replay) {
          if (replay.argsHash !== argsHash)
            return yield* fail(
              "conflict",
              "That clientRequestId was already used with different arguments.",
            );
          return replay.result;
        }
        const snapshot = yield* currentView(context);
        const ids = resolveTarget(snapshot, input.target);
        const keys = portFileKeys(yield* topicFileSets(context, snapshot, ids)).keysByTopic;
        const providers = yield* host.listProviders;
        if (
          !providers.some(
            (provider) =>
              provider.instanceId === input.modelSelection.instanceId && provider.enabled,
          )
        )
          return yield* fail("unavailable", "The selected provider instance is unavailable.");
        const result = yield* withPortLock(
          input.projectId,
          Effect.gen(function* () {
            const replay = yield* queue.getEnqueueRequest(input.projectId, input.clientRequestId);
            if (replay) {
              if (replay.argsHash !== argsHash)
                return yield* fail(
                  "conflict",
                  "That clientRequestId was already used with different arguments.",
                );
              return replay.result;
            }
            const fresh = yield* currentView(context);
            const skipped = queueSkips(
              fresh,
              ids,
              yield* queue.listQueuedTopicIds(input.projectId),
            );
            const excluded = new Set(skipped.map((skip) => skip.topicId));
            const ready = ids.filter((id) => !excluded.has(id));
            const groups = yield* Effect.try({
              try: () =>
                groupTopicIds(groupingTopics(fresh, ready, keys), input.grouping, {
                  batchSize: input.batchSize,
                }),
              catch: (error) =>
                new UpstreamPortsError({ code: "invalid", message: describe(error) }),
            });
            const entries = yield* queue.listQueue(input.projectId);
            const last = entries.reduce((max, entry) => Math.max(max, entry.position), -1);
            const at = now().toISOString();
            const result: UpstreamEnqueuePortResult = {
              queuedTopicIds: ready,
              queuedThreads: groups.length,
              skipped,
            };
            yield* deps.sql.withTransaction(
              Effect.gen(function* () {
                for (const [index, topicIds] of groups.entries())
                  yield* queue.setQueueEntry({
                    projectId: input.projectId,
                    entryId: mintId(),
                    position: last + index + 1,
                    topicIds,
                    topicEpochs: Object.fromEntries(
                      topicIds.map((id) => [id, fresh.view.topicsById.get(id)!.epoch]),
                    ),
                    modelSelection: input.modelSelection,
                    runtimeMode: input.runtimeMode,
                    requestId: input.clientRequestId,
                    fileKeys: [...new Set(topicIds.flatMap((id) => keys.get(id) ?? []))],
                    ignoreConflicts: false,
                    status: "queued",
                    threadId: null,
                    result: null,
                    topicResults: {},
                    reason: null,
                    createdAt: at,
                    updatedAt: at,
                    finishedAt: null,
                  });
                yield* queue.putEnqueueRequest(
                  input.projectId,
                  input.clientRequestId,
                  argsHash,
                  result,
                  at,
                );
              }),
            );
            return result;
          }),
        );
        yield* emit(input.projectId, "queue-updated");
        yield* wakePortQueue(input.projectId);
        return result;
      }).pipe(Effect.mapError(internal));

    const dequeuePort: UpstreamPortsService["dequeuePort"] = (input) =>
      Effect.gen(function* () {
        const context = yield* resolveContext(input.projectId);
        yield* requireConfig(context);
        yield* requireWriter(context.cwd);
        yield* withPortLock(
          input.projectId,
          queue.removeTopicsFromQueued(input.projectId, input.topicIds, now().toISOString()),
        );
        yield* emit(input.projectId, "queue-updated");
        yield* wakePortQueue(input.projectId);
        return { revision: (yield* currentView(context)).revision };
      }).pipe(Effect.mapError(internal));

    const controlPortQueue: UpstreamPortsService["controlPortQueue"] = (input) =>
      Effect.gen(function* () {
        const context = yield* resolveContext(input.projectId);
        yield* requireConfig(context);
        yield* requireWriter(context.cwd);
        yield* withPortLock(
          input.projectId,
          Effect.gen(function* () {
            if (input.action === "clear")
              yield* queue.clearQueued(input.projectId, now().toISOString());
            else if (input.action === "ignore-conflicts") {
              if (!input.entryId) return yield* fail("invalid", "Choose a queued entry.");
              const entry = (yield* queue.listQueue(input.projectId)).find(
                (entry) => entry.entryId === input.entryId,
              );
              if (entry?.status === "queued" && !entry.ignoreConflicts)
                yield* queue.setQueueEntry({
                  ...entry,
                  ignoreConflicts: true,
                  updatedAt: now().toISOString(),
                });
            } else {
              const state = yield* queue.getQueueState(input.projectId);
              yield* queue.setQueueState(input.projectId, {
                ...state,
                paused: input.action === "pause",
                pausedReason: null,
                ...(input.action === "resume"
                  ? { errorStreak: 0, holdKind: null, holdMessage: null, holdUntil: null }
                  : {}),
              });
            }
          }),
        );
        yield* emit(input.projectId, "queue-updated");
        yield* wakePortQueue(input.projectId);
        return { revision: (yield* currentView(context)).revision };
      }).pipe(Effect.mapError(internal));

    /** Recorded inapplicable topics have no port to merge. Release their files only
     * after the originating turn and any continuation have relinquished the slot. */
    const conflictLinks = (context: ProjectContext, snapshot: CurrentView) =>
      Effect.gen(function* () {
        const open = snapshot.links.filter((link) => {
          const row = snapshot.rows.find((row) => row.topic.id === link.topicId);
          return link.state === "active" && row?.topic.epoch === link.epoch && row.state !== "done";
        });
        const recordedSkips = new Set(
          snapshot.rows
            .filter(
              (row) =>
                row.state === "skipped" &&
                row.topic.decidedBy === "llm" &&
                row.topic.reasonKey === "not-applicable",
            )
            .map((row) => row.topic.id),
        );
        if (!open.some((link) => recordedSkips.has(link.topicId))) return open;
        const checks = yield* queue.getOutcomeChecks(context.projectId);
        const model = yield* host.readModel;
        const running = yield* runningThreads(context.projectId, snapshot);
        return open.filter((link) => {
          const turn = model.threads.find((thread) => thread.id === link.threadId)?.latestTurn;
          const check = checks.get(link.threadId);
          return (
            !recordedSkips.has(link.topicId) ||
            running.has(link.threadId) ||
            check?.result !== "recorded" ||
            check.turnId !== turn?.turnId
          );
        });
      });

    const openConflicts = (context: ProjectContext, snapshot: CurrentView) =>
      Effect.gen(function* () {
        const open = yield* conflictLinks(context, snapshot);
        const keys = portFileKeys(
          yield* topicFileSets(
            context,
            snapshot,
            open.map((link) => link.topicId),
          ),
          { dropHotPaths: false },
        ).keysByTopic;
        const model = yield* host.readModel;
        const outcomes = yield* readOutcomes(
          context,
          model,
          open.map((link) => link.threadId),
        ).pipe(Effect.orElseSucceed(() => new Map<string, ParsedUpstreamOutcomes>()));
        const summaries = yield* linkSummaries(
          context,
          open.map((link) => link.threadId),
          model,
          outcomes,
        );
        return open.map((link) => ({
          topicId: link.topicId,
          epoch: link.epoch,
          threadId: link.threadId,
          prUrl: summaries.get(link.threadId)?.prUrl ?? null,
          needsAttention: (() => {
            const thread = model.threads.find((thread) => thread.id === link.threadId);
            const turn = thread?.latestTurn;
            const parsed = outcomes.get(link.threadId);
            const outcome = parsed ? outcomeForTopic(parsed, link.topicId) : null;
            return (
              thread?.archivedAt != null ||
              (turn != null &&
                turn.processingQuiescedAt != null &&
                (["error", "interrupted"].includes(turn.state) ||
                  (turn.state === "completed" &&
                    !summaries.get(link.threadId)?.prUrl &&
                    !["equivalent", "not-applicable"].includes(outcome?.kind ?? ""))))
            );
          })(),
          keys: keys.get(link.topicId) ?? [],
        }));
      });
    const waitingOn = (
      entry: QueueRecord,
      conflicts: Effect.Success<ReturnType<typeof openConflicts>>,
    ) =>
      entry.ignoreConflicts
        ? []
        : conflicts
            .filter((other) => filesOverlap(entry.fileKeys, other.keys))
            .map(({ topicId, threadId, prUrl, needsAttention }) => ({
              topicId,
              threadId: threadId as UpstreamPortLinkSummary["threadId"],
              prUrl,
              needsAttention,
            }));

    const autoRecord = (context: ProjectContext, snapshot: CurrentView) =>
      Effect.gen(function* () {
        if (!context.settings.autoRecordOutcomes || !(yield* isWriter(context.cwd))) return;
        const model = yield* host.readModel;
        const links = snapshot.links.filter(
          (link) =>
            link.state === "active" &&
            snapshot.rows.some(
              (row) =>
                row.topic.id === link.topicId &&
                row.topic.epoch === link.epoch &&
                row.state === "in-progress",
            ),
        );
        const checks = yield* queue.getOutcomeChecks(context.projectId);
        const ids = [...new Set(links.map((link) => link.threadId))].filter((id) => {
          const thread = model.threads.find(
            (thread) => thread.id === id && thread.deletedAt === null,
          );
          const turn = thread?.latestTurn;
          const check = checks.get(id);
          return (
            check?.result !== "preexisting" &&
            turn?.state === "completed" &&
            turn.processingQuiescedAt != null &&
            turn.assistantMessageId != null &&
            check?.turnId !== turn.turnId
          );
        });
        const outcomes = yield* readOutcomes(context, model, ids);
        const summaries = yield* linkSummaries(context, ids, model, outcomes);
        for (const threadId of ids) {
          const thread = model.threads.find(
            (thread) => thread.id === threadId && thread.deletedAt === null,
          );
          const turn = thread?.latestTurn;
          const check = checks.get(threadId);
          if (
            check?.result === "preexisting" ||
            !turn ||
            turn.state !== "completed" ||
            turn.processingQuiescedAt == null ||
            !turn.assistantMessageId ||
            check?.turnId === turn.turnId
          )
            continue;
          const parsed = outcomes.get(threadId);
          if (!parsed) continue;
          const threadLinks = links.filter((link) => link.threadId === threadId);
          const candidates = threadLinks.filter(
            (link) =>
              links.filter((other) => other.topicId === link.topicId && other.epoch === link.epoch)
                .length === 1,
          );
          const attempted = yield* recordPlanned(context, "background", (fresh) => {
            const ops: UpstreamLedgerOp[] = [];
            for (const link of candidates) {
              const row = fresh.rows.find((row) => row.topic.id === link.topicId);
              if (
                row?.state !== "in-progress" ||
                row.topic.epoch !== link.epoch ||
                fresh.links.filter(
                  (other) =>
                    other.topicId === link.topicId &&
                    other.epoch === link.epoch &&
                    other.state === "active",
                ).length !== 1 ||
                !fresh.links.some(
                  (other) =>
                    other.threadId === threadId &&
                    other.topicId === link.topicId &&
                    other.epoch === link.epoch &&
                    other.state === "active",
                )
              )
                continue;
              const single =
                fresh.links.filter(
                  (other) => other.threadId === threadId && other.state === "active",
                ).length === 1;
              const decision = decisionFromOutcome(
                outcomeForTopic(parsed, link.topicId),
                single && !parsed.byTopic.has(link.topicId)
                  ? (summaries.get(threadId)?.prNumber ?? null)
                  : null,
              );
              if (
                !decision ||
                (decision.kind === "skip" &&
                  !fresh.base.rules?.reasonKeys.includes("not-applicable"))
              )
                continue;
              ops.push({
                kind: "decision",
                topicId: link.topicId,
                fields: decisionFields(row.topic, decision, {
                  rules: fresh.base.rules!,
                  state: row.state,
                  now: now().toISOString(),
                  today: today(),
                  baseSha: fresh.base.baseSha,
                  decidedBy: "llm",
                }),
              });
            }
            return { ops, result: ops.length };
          }).pipe(Effect.result);
          yield* queue.upsertOutcomeCheck({
            projectId: context.projectId,
            threadId,
            turnId: turn.turnId,
            result:
              attempted._tag === "Failure"
                ? "failed"
                : attempted.success > 0
                  ? "recorded"
                  : candidates.length === 0
                    ? "not-eligible"
                    : "no-outcome",
            detail: attempted._tag === "Failure" ? describe(attempted.failure) : null,
            checkedAt: now().toISOString(),
          });
        }
      });

    const baseEvidence = new Map<string, { at: string | null; error: string | null }>();
    const baseRefreshing = new Map<string, Promise<void>>();
    const refreshQueueBase = (context: ProjectContext) =>
      Effect.gen(function* () {
        const pending = baseRefreshing.get(context.projectId);
        if (pending) {
          yield* Effect.promise(() => pending);
          return;
        }
        const last = lastBaseFetch.get(context.projectId);
        if (last !== undefined && now().getTime() - last < BASE_FETCH_MIN_INTERVAL_MS) return;
        let done!: () => void;
        const promise = new Promise<void>((resolve) => {
          done = resolve;
        });
        baseRefreshing.set(context.projectId, promise);
        const before = baseCache.get(context.projectId)?.baseSha;
        yield* currentView(context, { fetch: true }).pipe(
          Effect.tap((fresh) =>
            Effect.gen(function* () {
              baseEvidence.set(context.projectId, { at: now().toISOString(), error: null });
              if (fresh.base.baseSha !== before) yield* emit(context.projectId, "ledger-updated");
            }),
          ),
          Effect.catch((error) =>
            Effect.sync(() =>
              baseEvidence.set(context.projectId, {
                at: baseEvidence.get(context.projectId)?.at ?? null,
                error: describe(error),
              }),
            ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              lastBaseFetch.set(context.projectId, now().getTime());
              baseRefreshing.delete(context.projectId);
              done();
            }),
          ),
        );
      });

    const getPortQueue: UpstreamPortsService["getPortQueue"] = (input) =>
      Effect.gen(function* () {
        const context = yield* resolveContext(input.projectId);
        yield* requireConfig(context);
        const records = yield* queue.listQueue(input.projectId);
        const snapshot = yield* currentView(context);
        const conflicts = yield* openConflicts(context, snapshot);
        const model = yield* host.readModel;
        const summaries = yield* linkSummaries(
          context,
          records.flatMap((entry) => (entry.threadId ? [entry.threadId] : [])),
          model,
        );
        const counts: UpstreamGetPortQueueResult["counts"] = {
          queued: 0,
          executing: 0,
          awaitingReview: 0,
          recorded: 0,
          needsAttention: 0,
          omitted: 0,
          cancelled: 0,
        };
        // Use a mutable local tally while keeping wire contracts readonly.
        const tally = { ...counts };
        const doneOnDefaultBranch = new Set<string>();
        const all = records.map((entry) => {
          const topics = Object.keys(entry.topicEpochs).map((topicId) => {
            const row = snapshot.rows.find((row) => row.topic.id === topicId);
            const epoch = entry.topicEpochs[topicId]!;
            const superseded = row?.topic.epoch !== epoch;
            const result = entry.topicResults[topicId] ?? entry.result;
            const baseTopic = snapshot.base.ledger.topics.find((topic) => topic.id === topicId);
            const onDefaultBranch =
              !superseded &&
              (snapshot.base.trailers.epochs.get(topicId)?.has(epoch) ||
                (baseTopic?.epoch === epoch && baseTopic.status === "equivalent"));
            if (onDefaultBranch) doneOnDefaultBranch.add(`${topicId}#${epoch}`);
            if (!entry.topicIds.includes(topicId)) {
              if (entry.topicResults[topicId] === "canceled") tally.cancelled++;
              else tally.omitted++;
            } else if (entry.status === "queued") tally.queued++;
            else if (entry.status === "started") tally.executing++;
            else if (entry.status === "dropped") {
              if (entry.result === "canceled") tally.cancelled++;
              else if (entry.result === "not-ready" || entry.result === "epoch-changed")
                tally.omitted++;
              else tally.needsAttention++;
            } else if (superseded) tally.omitted++;
            else if (
              !superseded &&
              row?.topic.decidedBy === "llm" &&
              ((result === "equivalent" && row.topic.status === "equivalent") ||
                (result === "not-applicable" &&
                  row.topic.status === "skip" &&
                  row.topic.reasonKey === "not-applicable"))
            )
              tally.recorded++;
            else if (onDefaultBranch) {
              /* Done is counted separately from unresolved work. */
            } else if (["pr", "equivalent", "not-applicable"].includes(result ?? ""))
              tally.awaitingReview++;
            else tally.needsAttention++;
            return {
              topicId,
              title: row?.topic.title ?? topicId,
              state: row?.state ?? null,
              epoch,
              superseded,
              result: result ?? null,
            };
          });
          return {
            entryId: entry.entryId,
            position: entry.position,
            topics,
            status: entry.status,
            result: entry.result,
            reason: entry.reason,
            threadId: entry.threadId as UpstreamPortLinkSummary["threadId"] | null,
            prUrl: summaries.get(entry.threadId ?? "")?.prUrl ?? null,
            fileCount: entry.fileKeys.length,
            waitingOn: entry.status === "queued" ? waitingOn(entry, conflicts) : [],
            ignoreConflicts: entry.ignoreConflicts,
          };
        });
        const filtered = all.filter(
          (entry) => !input.statuses?.length || input.statuses.includes(entry.status),
        );
        const offset = input.cursor ? Number(input.cursor) : 0;
        if (!Number.isSafeInteger(offset) || offset < 0)
          return yield* fail("invalid", "Invalid queue cursor.");
        const limit = input.limit ?? 100;
        // Keep panel reads responsive; a content push follows changed base evidence.
        if (tally.awaitingReview > 0) yield* track(refreshQueueBase(context));
        return {
          entries: filtered.slice(offset, offset + limit),
          nextCursor: offset + limit < filtered.length ? String(offset + limit) : null,
          counts: tally,
          doneOnDefaultBranch: doneOnDefaultBranch.size,
          baseEvidenceAt: baseEvidence.get(input.projectId)?.at ?? null,
          baseRefreshError: baseEvidence.get(input.projectId)?.error ?? null,
        };
      }).pipe(Effect.mapError(internal));

    const queueSummary = (context: ProjectContext, snapshot: CurrentView) =>
      Effect.gen(function* () {
        const entries = (yield* queue.listQueue(context.projectId)).filter(
          (entry) => entry.status === "queued",
        );
        const state = yield* queue.getQueueState(context.projectId);
        const automaticUsageRecovery =
          state.holdKind !== "usage" || (yield* host.getSettings).autoResumeUsageLimitedThreads;
        const conflicts = entries.length ? yield* openConflicts(context, snapshot) : [];
        return {
          queuedTopics: entries.reduce((sum, entry) => sum + entry.topicIds.length, 0),
          queuedThreads: entries.length,
          running: (yield* runningThreads(context.projectId, snapshot)).size,
          concurrency: context.settings.portConcurrency,
          waitingOnFiles: entries.filter((entry) => waitingOn(entry, conflicts).length > 0).length,
          paused: state.paused,
          pausedReason: state.pausedReason,
          hold: state.holdKind
            ? {
                kind: state.holdKind,
                message: state.holdMessage ?? "",
                retryAt: automaticUsageRecovery ? state.holdUntil : null,
              }
            : null,
        };
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("upstreamPorts.queue.summary.failed", { detail: describe(error) }).pipe(
            Effect.andThen(
              Effect.succeed({
                queuedTopics: 0,
                queuedThreads: 0,
                running: 0,
                concurrency: context.settings.portConcurrency,
                waitingOnFiles: 0,
                paused: false,
                pausedReason: null,
                hold: null,
              }),
            ),
          ),
        ),
      );

    /** Prune departed members and their files before choosing a non-conflicting entry. */
    const refreshQueuedEntries = (context: ProjectContext, snapshot: CurrentView) =>
      Effect.gen(function* () {
        const entries = (yield* queue.listQueue(context.projectId)).filter(
          (entry) => entry.status === "queued",
        );
        const rows = new Map(snapshot.rows.map((row) => [row.topic.id, row]));
        const files = yield* topicFileSets(
          context,
          snapshot,
          entries.flatMap((entry) => entry.topicIds),
        );
        let changed = false;
        for (const entry of entries) {
          const topicIds = entry.topicIds.filter((id) => {
            const row = rows.get(id);
            return row?.state === "ready" && row.topic.epoch === entry.topicEpochs[id];
          });
          const available = new Set(topicIds.flatMap((id) => files.get(id) ?? []));
          const fileKeys = topicIds.some((id) => files.get(id) == null)
            ? entry.fileKeys
            : entry.fileKeys.filter((key) => available.has(key));
          if (
            canonicalJson(topicIds) === canonicalJson(entry.topicIds) &&
            canonicalJson(fileKeys) === canonicalJson(entry.fileKeys)
          )
            continue;
          yield* withPortLock(
            context.projectId,
            Effect.gen(function* () {
              const current = (yield* queue.listQueue(context.projectId)).find(
                (current) => current.entryId === entry.entryId,
              );
              if (
                !current ||
                current.status !== "queued" ||
                canonicalJson(current.topicIds) !== canonicalJson(entry.topicIds)
              )
                return;
              const topicResults = { ...current.topicResults };
              for (const id of entry.topicIds.filter((id) => !topicIds.includes(id)))
                topicResults[id] =
                  rows.get(id)?.topic.epoch !== entry.topicEpochs[id]
                    ? "epoch-changed"
                    : "not-ready";
              yield* queue.setQueueEntry({
                ...current,
                topicIds,
                fileKeys,
                topicResults,
                updatedAt: now().toISOString(),
                ...(topicIds.length
                  ? {}
                  : {
                      status: "dropped",
                      result: "not-ready",
                      reason: "not-ready",
                      finishedAt: now().toISOString(),
                    }),
              });
              changed = true;
            }),
          );
        }
        return changed;
      });

    const dispatchProject = (projectId: string) =>
      Effect.gen(function* () {
        const context = yield* resolveContext(projectId);
        yield* requireConfig(context);
        let changed = false;
        const updateState = (patch: Partial<QueueState>) =>
          withPortLock(
            projectId,
            Effect.gen(function* () {
              const before = yield* queue.getQueueState(projectId);
              const next = { ...before, ...patch };
              if (canonicalJson(before) !== canonicalJson(next)) {
                yield* queue.setQueueState(projectId, next);
                changed = true;
              }
            }),
          );
        if (!(yield* isWriter(context.cwd))) {
          yield* updateState({
            holdKind: "writer",
            holdMessage: "This profile is not the upstream writer.",
            holdUntil: null,
          });
          if (changed) yield* emit(projectId, "queue-updated");
          return;
        }
        const pending = (yield* store.listPendingGroups).filter(
          (group) => group.projectId === projectId,
        );
        let submissionHold: { kind: "isolation" | "provider"; message: string } | null = null;
        for (const group of pending) {
          const submitted = yield* submitGroup(group);
          if (submitted.status !== group.status) changed = true;
          if (
            group.clientRequestId.startsWith("queue:") &&
            submitted.status === "pending" &&
            submitted.reason
          )
            submissionHold = {
              kind: /worktree|isolation/iu.test(submitted.reason) ? "isolation" : "provider",
              message: submitted.reason,
            };
        }
        let snapshot = yield* currentView(context);
        const running = yield* runningThreads(projectId, snapshot);
        const model = yield* host.readModel;
        const entries = yield* queue.listQueue(projectId);
        const parsed = yield* readOutcomes(
          context,
          model,
          entries.flatMap((entry) => (entry.threadId ? [entry.threadId] : [])),
        );
        for (const entry of entries.filter(
          (entry) => entry.status === "started" && !running.has(entry.threadId!),
        )) {
          const group = (yield* store.listGroups(projectId, `queue:${entry.entryId}`))[0];
          const thread = model.threads.find(
            (thread) => thread.id === entry.threadId && thread.deletedAt === null,
          );
          const result =
            group?.status === "rejected"
              ? "rejected"
              : !thread
                ? "missing"
                : thread.archivedAt
                  ? "archived"
                  : (thread.latestTurn?.state ?? "missing");
          // Projection may lag quiescence: retain the slot until its owned message exists.
          if (
            result === "completed" &&
            thread?.latestTurn?.assistantMessageId &&
            !parsed.has(thread.id)
          )
            continue;
          const outcomes = parsed.get(entry.threadId!);
          const topicResults = { ...entry.topicResults };
          for (const id of entry.topicIds)
            topicResults[id] =
              result === "completed"
                ? ((outcomes ? outcomeForTopic(outcomes, id)?.kind : null) ?? "no-outcome")
                : result;
          yield* withPortLock(
            projectId,
            Effect.gen(function* () {
              yield* queue.setQueueEntry({
                ...entry,
                status: "finished",
                result,
                topicResults,
                reason: group?.reason ?? null,
                updatedAt: now().toISOString(),
                finishedAt: now().toISOString(),
              });
              const state = yield* queue.getQueueState(projectId);
              const errorStreak = result === "error" ? state.errorStreak + 1 : 0;
              yield* queue.setQueueState(projectId, {
                ...state,
                errorStreak,
                ...(errorStreak >= 2
                  ? {
                      paused: true,
                      pausedReason:
                        "Two port threads in a row ended with an error. Check the provider, then resume.",
                    }
                  : {}),
              });
            }),
          );
          changed = true;
        }
        yield* autoRecord(context, snapshot);
        snapshot = yield* currentView(context);
        changed = (yield* refreshQueuedEntries(context, snapshot)) || changed;
        const state = yield* queue.getQueueState(projectId);
        if (submissionHold) {
          yield* updateState({
            holdKind: submissionHold.kind,
            holdMessage: submissionHold.message,
            holdUntil: null,
          });
          if (changed) yield* emit(projectId, "queue-updated");
          return;
        }
        const globalSettings = yield* host.getSettings;
        if (state.holdKind === "usage" && !globalSettings.autoResumeUsageLimitedThreads) {
          yield* updateState({
            holdMessage:
              "Usage recovery is disabled. Resume the queue when provider capacity is available.",
          });
          if (changed) yield* emit(projectId, "queue-updated");
          return;
        }
        if (!state.paused) {
          const stale = new Set<string>();
          while (true) {
            snapshot = yield* currentView(context);
            if (
              (yield* runningThreads(projectId, snapshot)).size >= context.settings.portConcurrency
            )
              break;
            const remaining = (yield* queue.listQueue(projectId)).filter(
              (entry) => entry.status === "queued" && !stale.has(entry.entryId),
            );
            if (!remaining.length) {
              yield* updateState({ holdKind: null, holdMessage: null, holdUntil: null });
              break;
            }
            if ((yield* queue.getQueueState(projectId)).paused) break;
            const conflicts = yield* openConflicts(context, snapshot);
            const entry = remaining.find((entry) => waitingOn(entry, conflicts).length === 0);
            if (!entry) {
              if (
                remaining.some((entry) => waitingOn(entry, conflicts).some((other) => other.prUrl))
              )
                yield* refreshQueueBase(context);
              break;
            }
            const at = now().toISOString();
            const ready = entry.topicIds.filter((id) =>
              snapshot.rows.some(
                (row) =>
                  row.topic.id === id &&
                  row.state === "ready" &&
                  row.topic.epoch === entry.topicEpochs[id],
              ),
            );
            if (ready.length !== entry.topicIds.length) {
              changed = (yield* refreshQueuedEntries(context, snapshot)) || changed;
              stale.add(entry.entryId);
              continue;
            }
            const accounts = yield* host.usageAccounts ?? Effect.succeed([]);
            const retryAt = scheduledUsageRetryAt(accounts, entry.modelSelection, now().getTime());
            const currentState = yield* queue.getQueueState(projectId);
            const preservedDeadline =
              currentState.holdKind === "usage" &&
              Date.parse(currentState.holdUntil ?? "") > now().getTime() &&
              !hasFreshUsageCapacity(accounts, entry.modelSelection, now().getTime())
                ? currentState.holdUntil
                : null;
            if (retryAt || preservedDeadline) {
              yield* updateState({
                holdKind: "usage",
                holdMessage: globalSettings.autoResumeUsageLimitedThreads
                  ? "Waiting for the provider usage limit to reset."
                  : "Usage recovery is disabled. Resume the queue when provider capacity is available.",
                holdUntil: retryAt ?? preservedDeadline,
              });
              break;
            }
            const providers = yield* host.listProviders;
            const provider = providers.find(
              (provider) => provider.instanceId === entry.modelSelection.instanceId,
            );
            if (
              !provider ||
              !isProviderUsable(provider) ||
              provider.auth.status === "unauthenticated" ||
              provider.probeOutcome === "loading" ||
              provider.probeOutcome === "transient_failure"
            ) {
              yield* updateState({
                holdKind: "provider",
                holdMessage: "The selected provider instance is unavailable.",
                holdUntil: null,
              });
              break;
            }
            yield* updateState({ holdKind: null, holdMessage: null, holdUntil: null });
            const result = yield* startPortImpl(
              {
                projectId: projectId as ProjectId,
                topicIds: entry.topicIds,
                grouping: "together",
                modelSelection: entry.modelSelection,
                runtimeMode: entry.runtimeMode,
                clientRequestId: `queue:${entry.entryId}`,
              },
              entry,
            ).pipe(Effect.result);
            if (result._tag === "Failure") {
              if (result.failure.code === "conflict") {
                stale.add(entry.entryId);
                continue;
              }
              if (result.failure.code === "unavailable") {
                yield* updateState({
                  holdKind: "provider",
                  holdMessage: result.failure.message,
                  holdUntil: null,
                });
                break;
              }
              if (result.failure.code === "invalid" || result.failure.code === "not-found") {
                const fresh = yield* currentView(context);
                if (yield* refreshQueuedEntries(context, fresh)) {
                  changed = true;
                  stale.add(entry.entryId);
                  continue;
                }
              }
              const reason = result.failure.message;
              yield* withPortLock(
                projectId,
                Effect.gen(function* () {
                  const current = (yield* queue.listQueue(projectId)).find(
                    (current) => current.entryId === entry.entryId,
                  );
                  if (
                    current?.status !== "queued" ||
                    canonicalJson(current.topicIds) !== canonicalJson(entry.topicIds)
                  )
                    return;
                  yield* queue.setQueueEntry({
                    ...current,
                    status: "dropped",
                    result: "error",
                    reason,
                    updatedAt: at,
                    finishedAt: at,
                  });
                }),
              );
            } else {
              const group = result.success.groups[0];
              if (group?.reason && /worktree|isolation/iu.test(group.reason)) {
                yield* updateState({
                  holdKind: "isolation",
                  holdMessage: group.reason,
                  holdUntil: null,
                });
                changed = true;
                break;
              }
            }
            changed = true;
          }
        }
        if (changed) yield* emit(projectId, "queue-updated");
      });
    const queueWorker = yield* makeBackgroundWorker<string, never, never>(
      (projectId) =>
        dispatchProject(projectId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("upstreamPorts.queue.project.failed", {
              projectId,
              cause,
            }),
          ),
        ),
      { name: "upstream-port-queue", key: (projectId) => projectId },
    );
    // Coalesce broad provider/settings wakes before scanning; thread events only
    // wake their owning projects rather than all projects with historical links.
    const queueWakeWorker = yield* makeBackgroundWorker<string | null, never, never>(
      (threadId) =>
        Effect.gen(function* () {
          const projects =
            threadId === null
              ? yield* queue.listProjectsWithPortWork.pipe(Effect.orElseSucceed(() => []))
              : (yield* deps.sql<{ project_id: string }>`
              SELECT project_id FROM upstream_port_links WHERE state = 'active' AND thread_id = ${threadId}
              UNION SELECT project_id FROM upstream_port_queue WHERE status = 'started' AND thread_id = ${threadId}`.pipe(
                  Effect.orElseSucceed(() => []),
                )).map((row) => row.project_id);
          for (const projectId of projects) yield* queueWorker.enqueue(projectId);
        }),
      { name: "upstream-port-queue-wakes", key: (threadId) => threadId ?? "all" },
    );
    const wakePortQueue = (projectId?: string, threadId?: string) =>
      projectId ? queueWorker.enqueue(projectId) : queueWakeWorker.enqueue(threadId ?? null);

    const unlinkPort: UpstreamPortsService["unlinkPort"] = (input) =>
      Effect.gen(function* () {
        const context = yield* resolveContext(input.projectId);
        yield* requireConfig(context);
        yield* requireWriter(context.cwd);
        const links = yield* store.listLinks(context.projectId);
        if (
          !links.some(
            (link) =>
              link.topicId === input.topicId &&
              link.threadId === input.threadId &&
              link.state === "active",
          )
        )
          return yield* fail(
            "not-found",
            `Topic ${input.topicId} is not linked to thread ${input.threadId}.`,
          );
        // Also bumps the links version.
        yield* store.setLinkState(
          { projectId: context.projectId, topicId: input.topicId, threadId: input.threadId },
          "unlinked",
        );
        yield* emit(context.projectId, "links-updated");
        return { revision: (yield* currentView(context)).revision };
      }).pipe(Effect.mapError(internal));

    const getPortPrompt: UpstreamPortsService["getPortPrompt"] = (input) =>
      Effect.gen(function* () {
        const context = yield* resolveContext(input.projectId);
        const config = yield* requireConfig(context);
        const snapshot = yield* currentView(context);
        const topics: UpstreamTopic[] = [];
        for (const topicId of input.topicIds) {
          const topic = snapshot.view.topicsById.get(topicId);
          if (!topic) return yield* fail("not-found", `Topic ${topicId} does not exist.`);
          topics.push(topic);
        }
        return { prompt: yield* portPrompt(context, config, snapshot, topics) };
      }).pipe(Effect.mapError(internal));

    const closeLedgerPullRequest = (context: ProjectContext, number: number) =>
      Effect.gen(function* () {
        const refuse = (detail: string) =>
          fail("unavailable", `Close ledger PR #${number} before discarding: ${detail}`);
        const originUrl = yield* git
          .remoteUrl(context.cwd, "origin")
          .pipe(Effect.orElseSucceed(() => null));
        const repo = originUrl ? parseGitHubRepo(originUrl) : null;
        if (!deps.github || !repo) return yield* refuse("GitHub is unavailable.");
        const github = deps.github;
        const pr = yield* github
          .findPullRequest({ cwd: context.cwd, repo, number })
          .pipe(Effect.catch((error) => refuse(error.detail)));
        if (pr?.state !== "open") return;
        yield* github
          .closePullRequest({ cwd: context.cwd, repo, number })
          .pipe(Effect.catch((error) => refuse(error.detail)));
      });

    const resolvePublication: UpstreamPortsService["resolvePublication"] = (input) =>
      Effect.gen(function* () {
        const context = yield* resolveContext(input.projectId);
        yield* requireConfig(context);
        if (input.action === "discard") {
          yield* withLock(
            context.cwd,
            "user",
            Effect.gen(function* () {
              yield* requireWriter(context.cwd);
              const publication = yield* store.getPublication(context.projectId);
              // The open ledger PR still carries the discarded ops; close it first so
              // it cannot merge them later.
              if (publication.prNumber !== null && publication.prState !== "merged")
                yield* closeLedgerPullRequest(context, publication.prNumber);
              yield* store.discardOpenOps(context.projectId, now().toISOString());
              yield* store.savePublication({
                ...DEFAULT_PUBLICATION(context.projectId),
                linksVersion: publication.linksVersion,
              });
            }),
          );
          viewCache.delete(context.projectId);
          baseCache.delete(context.projectId);
          lastBaseFetch.delete(context.projectId);
          yield* emit(context.projectId, "ledger-updated");
        } else {
          yield* requireWriter(context.cwd);
          lastBaseFetch.delete(context.projectId);
          yield* publishFor(context.projectId, input.action);
        }
        return { revision: (yield* currentView(context)).revision };
      }).pipe(Effect.mapError(internal));

    const addRemote: UpstreamPortsService["addRemote"] = (projectId) =>
      Effect.gen(function* () {
        const context = yield* resolveContext(projectId);
        const config = yield* requireConfig(context);
        const existing = yield* git
          .remoteUrl(context.cwd, config.remote)
          .pipe(Effect.mapError(internal));
        if (existing !== null)
          return yield* fail("conflict", `A ${config.remote} remote already exists (${existing}).`);
        yield* git
          .addRemote(context.cwd, config.remote, config.repository)
          .pipe(Effect.mapError(internal));
        return {
          revision: (yield* currentView(context).pipe(
            Effect.orElseSucceed(() => ({ revision: "none" })),
          )).revision,
        };
      }).pipe(Effect.mapError(internal));

    const takeOverWriter: UpstreamPortsService["takeOverWriter"] = (projectId) =>
      Effect.gen(function* () {
        const context = yield* resolveContext(projectId);
        yield* withLock(
          context.cwd,
          "user",
          Effect.gen(function* () {
            const file = yield* claimFile(context.cwd);
            yield* claimIo(() => takeOverWriterClaim(file, me, now().toISOString()));
          }),
        );
        const publication = yield* store.getPublication(context.projectId);
        if (publication.pausedReason === "writer-lost")
          yield* store.savePublication({ ...publication, pausedReason: null, lastError: null });
        schedulePublish(context.projectId, 0);
        yield* emit(context.projectId, "publication-updated");
        return {
          revision: (yield* currentView(context).pipe(
            Effect.orElseSucceed(() => ({ revision: "none" })),
          )).revision,
        };
      }).pipe(Effect.mapError(internal));

    const start: UpstreamPortsService["start"] = Effect.gen(function* () {
      const interrupted = yield* store
        .interruptRunningRuns(now().toISOString())
        .pipe(Effect.orElseSucceed(() => []));
      for (const runRecord of interrupted)
        yield* finishScheduled({ ...runRecord, status: "interrupted" }).pipe(Effect.ignore);
      yield* reconcilePendingGroups.pipe(Effect.ignoreCause({ log: true }));
      yield* wakePortQueue();
      yield* Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(15_000);
          yield* wakePortQueue();
        }
      }).pipe(Effect.forkScoped);
      yield* Effect.gen(function* () {
        while (true) {
          yield* schedulerTick.pipe(Effect.ignoreCause({ log: true }));
          yield* Effect.sleep(SCHEDULER_TICK_MS);
        }
      }).pipe(Effect.forkScoped);
      yield* publisherLoop.pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);
    });

    return {
      listProjects,
      getOverview,
      listTopics,
      listTopicIds,
      getTopic,
      decide,
      acceptSuggestions,
      undoDecisions,
      getTopicFiles,
      run,
      startPort,
      previewPortGroups,
      enqueuePort,
      getPortQueue,
      dequeuePort,
      controlPortQueue,
      wakePortQueue,
      unlinkPort,
      getPortPrompt,
      resolvePublication,
      addRemote,
      takeOverWriter,
      start,
      testing: {
        dispatchQueue: (projectId) =>
          queueWorker.enqueue(projectId).pipe(Effect.andThen(queueWorker.drain), Effect.orDie),
        schedulerTick: schedulerTick.pipe(Effect.ignoreCause({ log: true })),
        publishNow: (projectId) => publishFor(projectId).pipe(Effect.ignoreCause({ log: true })),
        awaitIdle: Effect.promise(async () => {
          while (inflight.size > 0) await Promise.all(inflight);
        }).pipe(
          Effect.andThen(queueWakeWorker.drain),
          Effect.andThen(queueWorker.drain),
          Effect.orDie,
        ),
      },
    } satisfies UpstreamPortsService;
  });
}
