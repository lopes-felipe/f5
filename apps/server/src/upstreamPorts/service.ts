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
  type UpstreamTopic,
  type UpstreamTopicDetail,
  type UpstreamTopicRow,
  type UpstreamUnlinkPortInput,
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
import { buildPortPrompt, parseUpstreamOutcome } from "@t3tools/shared/upstreamPortsPrompts";
import { Data, Effect, Exit, Schema, Scope } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
import type { UpstreamGit } from "./git.ts";
import { parseGitHubRepo, type UpstreamGitHub } from "./github.ts";
import {
  BASE_FETCH_MIN_INTERVAL_MS,
  PUBLISH_DEBOUNCE_MS,
  PUBLISH_INTERVAL_MS,
  publishStep,
} from "./publisher.ts";
import { runTriage, type ViewSnapshot } from "./runs.ts";
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
  buildView,
  countStates,
  deriveRows,
  EMPTY_TRAILERS,
  indexTrailers,
  pageRows,
  revisionOf,
  type DerivedRow,
  type LedgerView,
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

const internal = (error: unknown) =>
  error instanceof UpstreamPortsError
    ? error
    : new UpstreamPortsError({ code: "internal", message: describe(error) });

export interface UpstreamPortsHost {
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
}

const decodeSettings = Schema.decodeUnknownSync(UpstreamPortsSettings);

/** Decision fields without the timestamp/author, to detect no-op decisions. */
const decisionSignature = (fields: DecisionFields) => {
  const { decidedAt: _at, decidedBy: _by, ...rest } = fields;
  return canonicalJson(rest);
};

export interface UpstreamPortsService {
  readonly listProjects: Effect.Effect<UpstreamPortsListProjectsResult, UpstreamPortsError>;
  readonly getOverview: (
    projectId: ProjectId,
  ) => Effect.Effect<UpstreamOverview, UpstreamPortsError>;
  readonly listTopics: (
    input: UpstreamListTopicsInput,
  ) => Effect.Effect<UpstreamListTopicsResult, UpstreamPortsError>;
  readonly getTopic: (
    input: UpstreamGetTopicInput,
  ) => Effect.Effect<UpstreamTopicDetail, UpstreamPortsError>;
  readonly decide: (
    input: UpstreamDecideInput,
  ) => Effect.Effect<UpstreamDecideResult, UpstreamPortsError>;
  readonly acceptSuggestions: (
    input: UpstreamAcceptSuggestionsInput,
  ) => Effect.Effect<UpstreamDecideResult, UpstreamPortsError>;
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

    const isWriter = (cwd: string) =>
      claimFile(cwd).pipe(
        Effect.flatMap((file) => Effect.promise(() => readWriterClaim(file))),
        Effect.map((claim) => claim !== null && isSameWriter(claim, me)),
        Effect.orElseSucceed(() => false),
      );

    /** Claims an unclaimed repository; fails read-only when another profile holds it. */
    const requireWriter = (cwd: string) =>
      Effect.gen(function* () {
        const file = yield* claimFile(cwd);
        const mine = yield* Effect.promise(() => ensureWriterClaim(file, me, now().toISOString()));
        if (!mine) {
          const claim = yield* Effect.promise(() => readWriterClaim(file));
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

    const loadBase = (context: ProjectContext, options: { readonly fetch: boolean }) =>
      Effect.gen(function* () {
        const config = yield* requireConfig(context);
        const baseBranch =
          (yield* host.readDefaultBranch(context.cwd).pipe(Effect.orElseSucceed(() => null))) ??
          "main";
        if (options.fetch) {
          const last = lastBaseFetch.get(context.projectId) ?? 0;
          if (now().getTime() - last >= BASE_FETCH_MIN_INTERVAL_MS) {
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
        };
        baseCache.set(context.projectId, next);
        viewCache.delete(context.projectId);
        return next;
      });

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
        return { base, view, rows, links, publication, revision, maxSeq };
      });

    const requireRules = (base: BaseState) =>
      base.rules
        ? Effect.succeed(base.rules)
        : fail("unavailable", base.errors[0] ?? "The ledger rules are unavailable.");

    // ── Recording ──

    /** Records ops under the repository lock after the writer check; pushes `ledger-updated`. */
    const recordOps = (
      context: ProjectContext,
      ops: ReadonlyArray<UpstreamLedgerOp>,
      mode: "user" | "background",
      newInbox?: number,
    ) =>
      Effect.gen(function* () {
        if (ops.length === 0) return;
        yield* withLock(
          context.cwd,
          mode,
          Effect.gen(function* () {
            yield* requireWriter(context.cwd);
            const snapshot = yield* currentView(context);
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
          }),
        );
        viewCache.delete(context.projectId);
        yield* emit(context.projectId, "ledger-updated", newInbox);
        schedulePublish(context.projectId, PUBLISH_DEBOUNCE_MS);
      });

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
              loadBase: loadBase(context, { fetch: true }).pipe(
                Effect.map((base) => ({ baseSha: base.baseSha, ledger: base.ledger })),
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
        if (activeRuns.has(context.projectId))
          return yield* fail("busy", "A run is already in progress for this project.");
        const active = yield* store.activeRun(context.projectId).pipe(Effect.mapError(internal));
        if (active) return yield* fail("busy", "A run is already in progress for this project.");
        if (input.kind === "upstream") {
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
        activeRuns.add(context.projectId);
        yield* store.insertRun(record).pipe(
          Effect.mapError(internal),
          Effect.tapError(() => Effect.sync(() => activeRuns.delete(context.projectId))),
        );
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
        const work = runTriage(
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
            progress: (run) => store.updateRun(run).pipe(Effect.ignore),
            ...(deps.runLimits ? { limits: deps.runLimits } : {}),
          },
          record,
        ).pipe(
          Effect.tap((finished) =>
            Effect.gen(function* () {
              yield* store.updateRun(finished).pipe(Effect.ignore);
              yield* finishScheduled(finished).pipe(Effect.ignore);
              yield* emit(context.projectId, "run-finished", finished.inboxCount);
              schedulePublish(context.projectId, 0);
            }),
          ),
          Effect.ensuring(Effect.sync(() => activeRuns.delete(context.projectId))),
        );
        yield* track(work);
        return { runId };
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
          if (!(yield* Effect.promise(() => ensureWriterClaim(file, me, now().toISOString()))))
            return;
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

    const linkSummaries = (
      threadIds: ReadonlyArray<string>,
      model: OrchestrationReadModel | null,
    ) =>
      Effect.gen(function* () {
        const unique = [...new Set(threadIds)];
        if (unique.length === 0) return new Map<string, Omit<UpstreamPortLinkSummary, "epoch">>();
        const messages = yield* deps.sql<{ readonly thread_id: string; readonly text: string }>`
          SELECT m.thread_id, m.text FROM projection_thread_messages m
          WHERE m.role = 'assistant' AND ${deps.sql.in("m.thread_id", unique)}
            AND m.created_at = (
              SELECT MAX(created_at) FROM projection_thread_messages
              WHERE thread_id = m.thread_id AND role = 'assistant'
            )`.pipe(Effect.orElseSucceed(() => []));
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
          const message = messages.find((entry) => entry.thread_id === threadId);
          const pr = prs.find((entry) => entry.thread_id === threadId);
          out.set(threadId, {
            threadId: threadId as UpstreamPortLinkSummary["threadId"],
            threadTitle: thread?.title ?? null,
            threadStatus: thread
              ? thread.archivedAt
                ? "archived"
                : (thread.latestTurn?.state ?? "idle")
              : null,
            branch: thread?.branch ?? null,
            prNumber: pr ? Number(pr.number) : null,
            prUrl: pr?.url ?? null,
            prState: null,
            outcome: message ? parseUpstreamOutcome(message.text) : null,
          });
        }
        return out;
      });

    const toRows = (
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
        const summaries = yield* linkSummaries(
          relevant.map((link) => link.threadId),
          model,
        );
        return rows.map(
          (row): UpstreamTopicRow => ({
            topic: row.topic,
            state: row.state,
            commitCount: row.commitCount,
            doneBy: row.doneBy,
            links: relevant
              .filter((link) => link.topicId === row.topic.id && link.epoch === row.topic.epoch)
              .map((link) => ({ ...summaries.get(link.threadId)!, epoch: link.epoch })),
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
          [...(snapshot.view.members.get(topic.id) ?? [])]
            .toReversed()
            .map((member) => ({ sha: member.sha, subject: member.subject }));
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
        const outcome = yield* host
          .submitTurn({
            submissionId: CommandId.makeUnsafe(group.submissionId),
            command: group.command as NextTurnQueueSubmitInput["command"],
            intent: "auto",
          })
          .pipe(
            Effect.map((result) =>
              result?.disposition === "rejected" ||
              result?.disposition === "canceled" ||
              result?.disposition === "cleared"
                ? ({ status: "rejected", reason: result.detail ?? result.reasonCode } as const)
                : ({ status: "submitted", reason: null } as const),
            ),
            Effect.catch((error) =>
              Effect.succeed(
                isSettledRejection(error)
                  ? ({ status: "rejected", reason: error.message } as const)
                  : ({ status: "pending", reason: error.message } as const),
              ),
            ),
          );
        if (outcome.status === "pending") return { ...group, reason: outcome.reason };
        yield* store.setGroupStatus(group, outcome.status, outcome.reason, now().toISOString());
        if (outcome.status === "rejected") {
          for (const topicId of group.topicIds)
            yield* store.setLinkState(
              { projectId: group.projectId, topicId, threadId: group.threadId },
              "unlinked",
              { clientRequestId: group.clientRequestId, groupIndex: group.groupIndex },
            );
          yield* store.bumpLinksVersion(group.projectId);
        }
        return { ...group, status: outcome.status, reason: outcome.reason };
      });

    const reconcilePendingGroups = Effect.gen(function* () {
      const pending = yield* store.listPendingGroups;
      const touched = new Set<string>();
      for (const group of pending) {
        yield* submitGroup(group).pipe(
          Effect.catch((error) =>
            Effect.logWarning("upstreamPorts.reconcile.failed", { detail: describe(error) }),
          ),
        );
        touched.add(group.projectId);
      }
      for (const projectId of touched) yield* emit(projectId, "ports-updated");
    });

    // ── Decisions ──

    const applyDecisions = (
      input: { readonly projectId: ProjectId; readonly topicIds: ReadonlyArray<string> },
      decisionFor: (topic: UpstreamTopic) => UpstreamDecision | null,
    ) =>
      Effect.gen(function* () {
        const context = yield* resolveContext(input.projectId);
        yield* requireConfig(context);
        yield* requireWriter(context.cwd);
        const snapshot = yield* currentView(context);
        const rules = yield* requireRules(snapshot.base);
        const rowsById = new Map(snapshot.rows.map((row) => [row.topic.id, row]));
        const ops: UpstreamLedgerOp[] = [];
        const updated: string[] = [];
        const unchanged: string[] = [];
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
          if (decisionSignature(fields) === decisionSignature(pickDecisionFields(row.topic))) {
            unchanged.push(topicId);
            continue;
          }
          ops.push({ kind: "decision", topicId, fields });
          updated.push(topicId);
        }
        yield* recordOps(context, ops, "user");
        const after = yield* currentView(context);
        return { revision: after.revision, updated, unchanged } as UpstreamDecideResult;
      });

    // ── RPC ──

    const getOverview: UpstreamPortsService["getOverview"] = (projectId) =>
      Effect.gen(function* () {
        const context = yield* resolveContext(projectId);
        const claim = yield* claimFile(context.cwd).pipe(
          Effect.flatMap((file) => Effect.promise(() => describeWriterClaim(file, me))),
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
        const ghAvailable = deps.github ? yield* deps.github.available(context.cwd) : false;
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
        const page = pageRows(snapshot.rows, input, snapshot.revision);
        const topics = yield* toRows(page.rows, snapshot.links);
        return {
          revision: page.revision,
          status: page.status,
          nextCursor: page.nextCursor,
          topics,
        };
      }).pipe(Effect.mapError(internal));

    const getTopic: UpstreamPortsService["getTopic"] = (input) =>
      Effect.gen(function* () {
        const context = yield* resolveContext(input.projectId);
        const config = yield* requireConfig(context);
        const snapshot = yield* currentView(context);
        const row = snapshot.rows.find((entry) => entry.topic.id === input.topicId);
        if (!row) return yield* fail("not-found", `Topic ${input.topicId} does not exist.`);
        const [full] = yield* toRows([row], snapshot.links);
        const rowsById = new Map(snapshot.rows.map((entry) => [entry.topic.id, entry]));
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
        } satisfies UpstreamTopicDetail;
      }).pipe(Effect.mapError(internal));

    const decide: UpstreamPortsService["decide"] = (input) =>
      applyDecisions(input, () => input.decision).pipe(Effect.mapError(internal));

    const acceptSuggestions: UpstreamPortsService["acceptSuggestions"] = (input) =>
      applyDecisions(input, suggestionDecision).pipe(Effect.mapError(internal));

    const run: UpstreamPortsService["run"] = (input) =>
      Effect.gen(function* () {
        const context = yield* resolveContext(input.projectId);
        return yield* startRun(context, {
          kind: input.kind,
          triage: input.triage,
          trigger: input.trigger ?? "manual",
        });
      }).pipe(Effect.mapError(internal));

    const startPort: UpstreamPortsService["startPort"] = (input) =>
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
            try: () => groupTopicIds(input.topicIds, input.grouping),
            catch: (error) => new UpstreamPortsError({ code: "invalid", message: describe(error) }),
          });
          const providers = yield* host.listProviders;
          const provider = providers.find(
            (entry) => entry.instanceId === input.modelSelection.instanceId,
          );
          if (!provider || !provider.enabled)
            return yield* fail("unavailable", "The selected provider instance is unavailable.");
          const baseBranch = snapshot.base.baseBranch;
          const createdAt = now().toISOString();
          const runSetupScript = setupProjectScript(context.scripts) !== null;
          const built = [];
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
              }),
              epochs: topics.map((topic) => ({ topicId: topic.id, epoch: topic.epoch })),
            });
          }
          const inserted = yield* store
            .insertPortRequest({
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
            })
            .pipe(Effect.mapError(internal));
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
          yield* emit(context.projectId, "ports-updated");
        }
        const results = [];
        for (const group of groups)
          results.push(
            group.status === "pending"
              ? yield* submitGroup(group).pipe(Effect.mapError(internal))
              : group,
          );
        yield* emit(context.projectId, "ports-updated");
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

    const unlinkPort: UpstreamPortsService["unlinkPort"] = (input) =>
      Effect.gen(function* () {
        const context = yield* resolveContext(input.projectId);
        yield* store.setLinkState(
          { projectId: context.projectId, topicId: input.topicId, threadId: input.threadId },
          "unlinked",
        );
        yield* store.bumpLinksVersion(context.projectId);
        yield* emit(context.projectId, "ports-updated");
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
              yield* store.discardOpenOps(context.projectId, now().toISOString());
              const publication = yield* store.getPublication(context.projectId);
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
            yield* Effect.promise(() => takeOverWriterClaim(file, me, now().toISOString()));
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
      getTopic,
      decide,
      acceptSuggestions,
      run,
      startPort,
      unlinkPort,
      getPortPrompt,
      resolvePublication,
      addRemote,
      takeOverWriter,
      start,
      testing: {
        schedulerTick: schedulerTick.pipe(Effect.ignoreCause({ log: true })),
        publishNow: (projectId) => publishFor(projectId).pipe(Effect.ignoreCause({ log: true })),
        awaitIdle: Effect.promise(async () => {
          while (inflight.size > 0) await Promise.all(inflight);
        }),
      },
    } satisfies UpstreamPortsService;
  });
}
