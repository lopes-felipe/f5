import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import readline from "node:readline";

import {
  ApprovalRequestId,
  type CodexMcpServerEntry,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  type ProjectMemory,
  ProviderItemId,
  ProviderRequestKind,
  type ProviderUserInputAnswers,
  ThreadId,
  type ThreadSessionNotes,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  RuntimeMode,
  ProviderInteractionMode,
} from "@t3tools/contracts";
import { isIgnorableCodexProcessStderrMessage } from "@t3tools/shared/codexStderr";
import { normalizeModelSlug } from "@t3tools/shared/model";
import { Effect, ServiceMap } from "effect";

import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "./provider/codexCliVersion";
import {
  buildCodexAssistantInstructions,
  buildInstructionProfile,
  INSTRUCTION_PROFILE_CONFIG_KEY,
  type SharedInstructionInput,
} from "./provider/sharedAssistantContract";
import {
  lookupModelContextWindowTokens,
  readCodexModelContextWindowCatalog,
} from "./provider/modelContextWindowMetadata.ts";
import { prependCodexCliTelemetryDisabledConfig } from "./provider/codexCliConfig";
import { buildProviderChildProcessEnv } from "./providerProcessEnv";
import {
  fingerprintSupportedSlashCommands,
  normalizeSupportedSlashCommands,
  type SupportedSlashCommand,
} from "./provider/supportedSlashCommands";
import { createJsonRpcStdinWriter, type JsonRpcStdinWriter } from "./codex/JsonRpcStdinWriter.ts";
import { resolveCodexHome } from "./os-jank.ts";

type PendingRequestKey = string;

interface PendingRequest {
  method: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface PendingApprovalRequest {
  requestId: ApprovalRequestId;
  jsonRpcId: string | number;
  method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
    | "item/fileRead/requestApproval"
    | "item/permissions/requestApproval";
  requestKind: ProviderRequestKind;
  responseKind: "decision" | "permissions";
  requestedPermissions?: Record<string, unknown>;
  threadId: ThreadId;
  turnId?: TurnId;
  itemId?: ProviderItemId;
}

interface PendingUserInputRequest {
  requestId: ApprovalRequestId;
  jsonRpcId: string | number;
  threadId: ThreadId;
  turnId?: TurnId;
  itemId?: ProviderItemId;
}

interface CodexUserInputAnswer {
  answers: string[];
}

interface CodexSessionContext {
  session: ProviderSession;
  account: CodexAccountSnapshot;
  child: ChildProcessWithoutNullStreams;
  output: readline.Interface;
  writer: JsonRpcStdinWriter;
  pending: Map<PendingRequestKey, PendingRequest>;
  pendingApprovals: Map<ApprovalRequestId, PendingApprovalRequest>;
  pendingUserInputs: Map<ApprovalRequestId, PendingUserInputRequest>;
  instructionContext?: Partial<SharedInstructionInput>;
  configuredBase?: Record<string, unknown>;
  availableSkills: ReadonlyArray<SupportedSlashCommand>;
  supportedCommandsFingerprint: string;
  skillsLoaded: boolean;
  skillRefreshInFlight: boolean;
  skillRefreshPending: boolean;
  initialSkillsRetryTimeout: ReturnType<typeof setTimeout> | undefined;
  initialSkillsRetryAttempted: boolean;
  resumedContextSent: boolean;
  nextRequestId: number;
  stopping: boolean;
}

interface JsonRpcError {
  code?: number;
  message?: string;
}

interface JsonRpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

type CodexPlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "team"
  | "business"
  | "enterprise"
  | "edu"
  | "unknown";

interface CodexAccountSnapshot {
  readonly type: "apiKey" | "chatgpt" | "unknown";
  readonly planType: CodexPlanType | null;
  readonly sparkEnabled: boolean;
}

export interface CodexAppServerSendTurnInput {
  readonly threadId: ThreadId;
  readonly input?: string;
  readonly attachments?: ReadonlyArray<{ type: "image"; url: string }>;
  readonly model?: string;
  readonly serviceTier?: string | null;
  readonly effort?: string;
  readonly interactionMode?: ProviderInteractionMode;
}

export interface CodexAppServerStartSessionInput {
  readonly threadId: ThreadId;
  readonly provider?: "codex";
  readonly cwd?: string;
  readonly projectTitle?: string;
  readonly threadTitle?: string;
  readonly turnCount?: number;
  readonly projectMemories?: ReadonlyArray<ProjectMemory>;
  readonly priorWorkSummary?: string;
  readonly preservedTranscriptBefore?: string;
  readonly preservedTranscriptAfter?: string;
  readonly restoredRecentFileRefs?: ReadonlyArray<string>;
  readonly restoredActivePlan?: string;
  readonly restoredTasks?: ReadonlyArray<string>;
  readonly sessionNotes?: ThreadSessionNotes;
  readonly model?: string;
  readonly serviceTier?: string;
  readonly mcpServers?: Record<string, CodexMcpServerEntry>;
  readonly resumeCursor?: unknown;
  readonly providerOptions?: ProviderSessionStartInput["providerOptions"];
  readonly runtimeMode: RuntimeMode;
}

export interface CodexThreadTurnSnapshot {
  id: TurnId;
  items: unknown[];
}

export interface CodexThreadSnapshot {
  threadId: string;
  turns: CodexThreadTurnSnapshot[];
}

const CODEX_VERSION_CHECK_TIMEOUT_MS = 4_000;

const ANSI_ESCAPE_CHAR = String.fromCharCode(27);
const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;]*m`, "g");
const CODEX_STDERR_LOG_REGEX =
  /^\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+\S+:\s+(.*)$/;
const RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS = [
  "not found",
  "missing thread",
  "no such thread",
  "unknown thread",
  "does not exist",
];
const CODEX_SPARK_FALLBACK_MODEL = "gpt-5.3-codex";
const CODEX_SPARK_MODEL = "gpt-5.3-codex-spark";
const CODEX_SPARK_DISABLED_PLAN_TYPES = new Set<CodexPlanType>(["free", "go", "plus"]);
const CODEX_ONE_OFF_THREAD_PREFIX = "one-off:";
const CODEX_ONE_OFF_PROMPT_TIMEOUT_MS = 120_000;
const CODEX_SKILLS_REFRESH_TIMEOUT_MS = 5_000;
const CODEX_INITIAL_SKILLS_RETRY_DELAY_MS = 2_000;
const EMPTY_SUPPORTED_COMMANDS_FINGERPRINT = fingerprintSupportedSlashCommands([]);

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function readCodexPermissionProfile(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function codexPermissionApprovalResponse(
  decision: ProviderApprovalDecision,
  requestedPermissions: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const permissions = requestedPermissions ?? {};
  if (decision === "accept") {
    return { permissions };
  }
  if (decision === "acceptForSession") {
    return { scope: "session", permissions };
  }
  return { permissions: {} };
}

function codexApprovalResponse(
  pendingRequest: PendingApprovalRequest,
  decision: ProviderApprovalDecision,
): Record<string, unknown> {
  switch (pendingRequest.responseKind) {
    case "decision":
      return { decision };
    case "permissions":
      return codexPermissionApprovalResponse(decision, pendingRequest.requestedPermissions);
    default: {
      const exhaustive: never = pendingRequest.responseKind;
      return exhaustive;
    }
  }
}

export function readEnabledSkillsFromSkillsListResponse(
  response: unknown,
  options?: {
    readonly onDroppedSkill?: (input: {
      readonly reason: "missing_name" | "missing_description";
      readonly skill: Record<string, unknown>;
    }) => void;
  },
): ReadonlyArray<SupportedSlashCommand> {
  const record = asObject(response);
  const entries = asArray(record?.data);
  if (!entries) {
    return [];
  }

  const skills: SupportedSlashCommand[] = [];
  for (const entryValue of entries) {
    const entry = asObject(entryValue);
    const entrySkills = asArray(entry?.skills);
    if (!entrySkills) {
      continue;
    }

    for (const skillValue of entrySkills) {
      const skill = asObject(skillValue);
      if (!skill || skill.enabled !== true) {
        continue;
      }

      const skillInterface = asObject(skill.interface);
      const name = asString(skill.name);
      if (!name) {
        options?.onDroppedSkill?.({
          reason: "missing_name",
          skill,
        });
        continue;
      }

      const description =
        asString(skillInterface?.shortDescription) ??
        asString(skill.shortDescription) ??
        asString(skill.description);
      if (!description) {
        options?.onDroppedSkill?.({
          reason: "missing_description",
          skill,
        });
        continue;
      }

      skills.push({
        name,
        description,
      });
    }
  }

  return skills;
}

function describeDroppedSkill(skill: Record<string, unknown>): string {
  const name = asString(skill.name);
  const path = asString(skill.path);
  if (name && path) {
    return `${name} (${path})`;
  }
  if (name) {
    return name;
  }
  if (path) {
    return path;
  }
  return "unknown skill";
}

export function readCodexAccountSnapshot(response: unknown): CodexAccountSnapshot {
  const record = asObject(response);
  const account = asObject(record?.account) ?? record;
  const accountType = asString(account?.type);

  if (accountType === "apiKey") {
    return {
      type: "apiKey",
      planType: null,
      sparkEnabled: true,
    };
  }

  if (accountType === "chatgpt") {
    const planType = (account?.planType as CodexPlanType | null) ?? "unknown";
    return {
      type: "chatgpt",
      planType,
      sparkEnabled: !CODEX_SPARK_DISABLED_PLAN_TYPES.has(planType),
    };
  }

  return {
    type: "unknown",
    planType: null,
    sparkEnabled: true,
  };
}

function mapCodexRuntimeMode(runtimeMode: RuntimeMode): {
  readonly approvalPolicy: "on-request" | "never";
  readonly sandbox: "workspace-write" | "danger-full-access";
} {
  if (runtimeMode === "approval-required") {
    return {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    };
  }

  return {
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  };
}

export function resolveCodexModelForAccount(
  model: string | undefined,
  account: CodexAccountSnapshot,
): string | undefined {
  if (model !== CODEX_SPARK_MODEL || account.sparkEnabled) {
    return model;
  }

  return CODEX_SPARK_FALLBACK_MODEL;
}

/**
 * On Windows with `shell: true`, `child.kill()` only terminates the `cmd.exe`
 * wrapper, leaving the actual command running. Use `taskkill /T` to kill the
 * entire process tree instead.
 */
export function killChildTree(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // fallback to direct kill
    }
  }
  child.kill();
}

export function normalizeCodexModelSlug(
  model: string | undefined | null,
  preferredId?: string,
): string | undefined {
  const normalized = normalizeModelSlug(model);
  if (!normalized) {
    return undefined;
  }

  if (preferredId?.endsWith("-codex") && preferredId !== normalized) {
    return preferredId;
  }

  return normalized;
}

export function buildCodexInitializeParams() {
  return {
    clientInfo: {
      name: "t3code_desktop",
      title: "F5 Desktop",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  } as const;
}

function buildCodexCollaborationMode(input: {
  readonly interactionMode?: "default" | "plan";
  readonly model?: string;
  readonly effort?: string;
  readonly instructionContext?: Partial<SharedInstructionInput>;
  readonly includeResumedContext?: boolean;
}): {
  mode: "default" | "plan";
  settings: {
    model: string;
    reasoning_effort: string;
    developer_instructions: string;
  };
} {
  const effectiveMode = input.interactionMode ?? "default";
  const model = normalizeCodexModelSlug(input.model) ?? DEFAULT_MODEL_BY_PROVIDER.codex;
  const context = input.instructionContext;
  const instructionInput: SharedInstructionInput = {
    interactionMode: effectiveMode,
    model,
    currentDate: new Date().toISOString().slice(0, 10),
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
    ...(context?.projectTitle ? { projectTitle: context.projectTitle } : {}),
    ...(context?.threadTitle ? { threadTitle: context.threadTitle } : {}),
    ...(context?.turnCount !== undefined ? { turnCount: context.turnCount } : {}),
    ...(context?.cwd ? { cwd: context.cwd } : {}),
    ...(context?.runtimeMode ? { runtimeMode: context.runtimeMode } : {}),
    ...(context?.projectMemories ? { projectMemories: context.projectMemories } : {}),
    ...(input.includeResumedContext && context?.priorWorkSummary
      ? { priorWorkSummary: context.priorWorkSummary }
      : {}),
    ...(input.includeResumedContext && context?.preservedTranscriptBefore
      ? { preservedTranscriptBefore: context.preservedTranscriptBefore }
      : {}),
    ...(input.includeResumedContext && context?.preservedTranscriptAfter
      ? { preservedTranscriptAfter: context.preservedTranscriptAfter }
      : {}),
    ...(input.includeResumedContext && context?.restoredRecentFileRefs
      ? { restoredRecentFileRefs: context.restoredRecentFileRefs }
      : {}),
    ...(input.includeResumedContext && context?.restoredActivePlan
      ? { restoredActivePlan: context.restoredActivePlan }
      : {}),
    ...(input.includeResumedContext && context?.restoredTasks
      ? { restoredTasks: context.restoredTasks }
      : {}),
    ...(input.includeResumedContext && context?.sessionNotes
      ? { sessionNotes: context.sessionNotes }
      : {}),
  };
  return {
    mode: effectiveMode,
    settings: {
      model,
      reasoning_effort: input.effort ?? "medium",
      developer_instructions: buildCodexAssistantInstructions(instructionInput),
    },
  };
}

function buildCodexInstructionContext(
  input: CodexAppServerStartSessionInput,
  resolvedCwd: string,
): Partial<SharedInstructionInput> {
  return {
    ...(input.projectTitle ? { projectTitle: input.projectTitle } : {}),
    ...(input.threadTitle ? { threadTitle: input.threadTitle } : {}),
    ...(input.turnCount !== undefined ? { turnCount: input.turnCount } : {}),
    cwd: resolvedCwd,
    runtimeMode: input.runtimeMode,
    ...(input.projectMemories ? { projectMemories: input.projectMemories } : {}),
    ...(input.priorWorkSummary ? { priorWorkSummary: input.priorWorkSummary } : {}),
    ...(input.preservedTranscriptBefore
      ? { preservedTranscriptBefore: input.preservedTranscriptBefore }
      : {}),
    ...(input.preservedTranscriptAfter
      ? { preservedTranscriptAfter: input.preservedTranscriptAfter }
      : {}),
    ...(input.restoredRecentFileRefs
      ? { restoredRecentFileRefs: input.restoredRecentFileRefs }
      : {}),
    ...(input.restoredActivePlan ? { restoredActivePlan: input.restoredActivePlan } : {}),
    ...(input.restoredTasks ? { restoredTasks: input.restoredTasks } : {}),
    ...(input.sessionNotes ? { sessionNotes: input.sessionNotes } : {}),
  };
}

export function isSyntheticOneOffThreadId(threadId: ThreadId): boolean {
  return threadId.startsWith(CODEX_ONE_OFF_THREAD_PREFIX);
}

function toCodexUserInputAnswer(value: unknown): CodexUserInputAnswer {
  if (typeof value === "string") {
    return { answers: [value] };
  }

  if (Array.isArray(value)) {
    const answers = value.filter((entry): entry is string => typeof entry === "string");
    return { answers };
  }

  if (value && typeof value === "object") {
    const maybeAnswers = (value as { answers?: unknown }).answers;
    if (Array.isArray(maybeAnswers)) {
      const answers = maybeAnswers.filter((entry): entry is string => typeof entry === "string");
      return { answers };
    }
  }

  throw new Error("User input answers must be strings or arrays of strings.");
}

function toCodexUserInputAnswers(
  answers: ProviderUserInputAnswers,
): Record<string, CodexUserInputAnswer> {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => [
      questionId,
      toCodexUserInputAnswer(value),
    ]),
  );
}

export function classifyCodexStderrLine(rawLine: string): { message: string } | null {
  const line = rawLine.replaceAll(ANSI_ESCAPE_REGEX, "").trim();
  if (!line) {
    return null;
  }

  if (isIgnorableCodexProcessStderrMessage(line)) {
    return null;
  }

  const match = line.match(CODEX_STDERR_LOG_REGEX);
  if (match) {
    const level = match[1];
    if (level && level !== "ERROR") {
      return null;
    }
  }

  return { message: line };
}

export function isRecoverableThreadResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message.includes("thread/resume")) {
    return false;
  }

  return RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS.some((snippet) => message.includes(snippet));
}

export interface CodexAppServerManagerEvents {
  event: [event: ProviderEvent];
}

export class CodexAppServerManager extends EventEmitter<CodexAppServerManagerEvents> {
  private readonly sessions = new Map<ThreadId, CodexSessionContext>();
  private modelContextWindowCatalog = new Map<string, number>();

  private runPromise: (effect: Effect.Effect<unknown, never>) => Promise<unknown>;
  constructor(services?: ServiceMap.ServiceMap<never>) {
    super();
    this.runPromise = services ? Effect.runPromiseWith(services) : Effect.runPromise;
  }

  async startSession(input: CodexAppServerStartSessionInput): Promise<ProviderSession> {
    const threadId = input.threadId;
    const now = new Date().toISOString();
    let context: CodexSessionContext | undefined;
    const resumeThreadId = readResumeThreadId(input);
    const requestedModel = normalizeCodexModelSlug(input.model);
    const fallbackModel =
      requestedModel ?? (resumeThreadId ? undefined : DEFAULT_MODEL_BY_PROVIDER.codex);

    try {
      const resolvedCwd = input.cwd ?? process.cwd();

      const session: ProviderSession = {
        provider: "codex",
        status: "connecting",
        runtimeMode: input.runtimeMode,
        ...(fallbackModel ? { model: fallbackModel } : {}),
        cwd: resolvedCwd,
        threadId,
        createdAt: now,
        updatedAt: now,
      };

      const codexOptions = readCodexProviderOptions(input);
      const codexBinaryPath = codexOptions.binaryPath ?? "codex";
      const codexHomePath = resolveCodexHome({ homePath: codexOptions.homePath });
      this.assertSupportedCodexCliVersion({
        binaryPath: codexBinaryPath,
        cwd: resolvedCwd,
        ...(codexHomePath ? { homePath: codexHomePath } : {}),
      });
      const child = spawn(
        codexBinaryPath,
        prependCodexCliTelemetryDisabledConfig(["app-server"], {
          mcpServers: input.mcpServers ?? {},
        }),
        {
          cwd: resolvedCwd,
          env: buildProviderChildProcessEnv(
            process.env,
            codexHomePath ? { CODEX_HOME: codexHomePath } : undefined,
          ),
          stdio: ["pipe", "pipe", "pipe"],
          shell: process.platform === "win32",
        },
      );
      const output = readline.createInterface({ input: child.stdout });
      const writer = createJsonRpcStdinWriter({
        stdin: child.stdin,
        closedMessage: "Cannot write to codex app-server stdin.",
      });

      context = {
        session,
        account: {
          type: "unknown",
          planType: null,
          sparkEnabled: true,
        },
        child,
        output,
        writer,
        pending: new Map(),
        pendingApprovals: new Map(),
        pendingUserInputs: new Map(),
        instructionContext: buildCodexInstructionContext(input, resolvedCwd),
        availableSkills: [],
        supportedCommandsFingerprint: EMPTY_SUPPORTED_COMMANDS_FINGERPRINT,
        skillsLoaded: false,
        skillRefreshInFlight: false,
        skillRefreshPending: false,
        initialSkillsRetryTimeout: undefined,
        initialSkillsRetryAttempted: false,
        resumedContextSent: false,
        nextRequestId: 1,
        stopping: false,
      };

      this.sessions.set(threadId, context);
      this.attachProcessListeners(context);

      this.emitLifecycleEvent(context, "session/connecting", "Starting codex app-server");

      await this.sendRequest(context, "initialize", buildCodexInitializeParams());

      await this.writeMessage(context, { method: "initialized" });
      try {
        const modelListResponse = await this.sendRequest(context, "model/list", {});
        const nextCatalog = readCodexModelContextWindowCatalog(modelListResponse);
        if (nextCatalog.size > 0) {
          this.modelContextWindowCatalog = new Map(nextCatalog);
        }
      } catch (error) {
        await Effect.logDebug("codex model/list did not expose context window metadata", {
          threadId,
          cause: error instanceof Error ? error.message : String(error),
        }).pipe(this.runPromise);
      }
      try {
        const accountReadResponse = await this.sendRequest(context, "account/read", {});
        console.log("codex account/read response", accountReadResponse);
        context.account = readCodexAccountSnapshot(accountReadResponse);
        console.log("codex subscription status", {
          type: context.account.type,
          planType: context.account.planType,
          sparkEnabled: context.account.sparkEnabled,
        });
      } catch (error) {
        console.log("codex account/read failed", error);
      }

      const normalizedModel = resolveCodexModelForAccount(fallbackModel, context.account);
      const sessionOverrides = {
        model: normalizedModel ?? null,
        ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
        cwd: input.cwd ?? null,
        ...mapCodexRuntimeMode(input.runtimeMode ?? "full-access"),
      };

      const threadStartParams = {
        ...sessionOverrides,
        experimentalRawEvents: false,
      };
      this.emitLifecycleEvent(
        context,
        "session/threadOpenRequested",
        resumeThreadId
          ? `Attempting to resume thread ${resumeThreadId}.`
          : "Starting a new Codex thread.",
      );
      await Effect.logInfo("codex app-server opening thread", {
        threadId,
        requestedRuntimeMode: input.runtimeMode,
        requestedModel: normalizedModel ?? null,
        requestedCwd: resolvedCwd,
        resumeThreadId: resumeThreadId ?? null,
      }).pipe(this.runPromise);

      let threadOpenMethod: "thread/start" | "thread/resume" = "thread/start";
      let threadOpenResponse: unknown;
      if (resumeThreadId) {
        try {
          threadOpenMethod = "thread/resume";
          threadOpenResponse = await this.sendRequest(context, "thread/resume", {
            ...sessionOverrides,
            threadId: resumeThreadId,
          });
        } catch (error) {
          if (!isRecoverableThreadResumeError(error)) {
            this.emitErrorEvent(
              context,
              "session/threadResumeFailed",
              error instanceof Error ? error.message : "Codex thread resume failed.",
            );
            await Effect.logWarning("codex app-server thread resume failed", {
              threadId,
              requestedRuntimeMode: input.runtimeMode,
              resumeThreadId,
              recoverable: false,
              cause: error instanceof Error ? error.message : String(error),
            }).pipe(this.runPromise);
            throw error;
          }

          threadOpenMethod = "thread/start";
          this.emitLifecycleEvent(
            context,
            "session/threadResumeFallback",
            `Could not resume thread ${resumeThreadId}; started a new thread instead.`,
          );
          await Effect.logWarning("codex app-server thread resume fell back to fresh start", {
            threadId,
            requestedRuntimeMode: input.runtimeMode,
            resumeThreadId,
            recoverable: true,
            cause: error instanceof Error ? error.message : String(error),
          }).pipe(this.runPromise);
          threadOpenResponse = await this.sendRequest(context, "thread/start", threadStartParams);
        }
      } else {
        threadOpenMethod = "thread/start";
        threadOpenResponse = await this.sendRequest(context, "thread/start", threadStartParams);
      }

      const threadOpenRecord = this.readObject(threadOpenResponse);
      const threadIdRaw =
        this.readString(this.readObject(threadOpenRecord, "thread"), "id") ??
        this.readString(threadOpenRecord, "threadId");
      if (!threadIdRaw) {
        throw new Error(`${threadOpenMethod} response did not include a thread id.`);
      }
      const providerThreadId = threadIdRaw;

      this.updateSession(context, {
        status: "ready",
        resumeCursor: { threadId: providerThreadId },
      });
      // Only skip replaying restored context when Codex actually reopened the
      // original provider thread. Fallback thread/start still needs that
      // context on the first follow-up turn.
      context.resumedContextSent = threadOpenMethod === "thread/resume";
      const modelContextWindowTokens =
        normalizedModel !== null && normalizedModel !== undefined
          ? lookupModelContextWindowTokens({
              provider: "codex",
              model: normalizedModel,
              catalog: this.modelContextWindowCatalog,
            })
          : undefined;
      this.emitSessionConfigured(context, {
        ...(normalizedModel ? { model: normalizedModel } : {}),
        ...(modelContextWindowTokens !== undefined ? { modelContextWindowTokens } : {}),
        ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
        ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
        [INSTRUCTION_PROFILE_CONFIG_KEY]: buildInstructionProfile({ provider: "codex" }),
      });
      this.emitLifecycleEvent(
        context,
        "session/threadOpenResolved",
        `Codex ${threadOpenMethod} resolved.`,
      );
      await Effect.logInfo("codex app-server thread open resolved", {
        threadId,
        threadOpenMethod,
        requestedResumeThreadId: resumeThreadId ?? null,
        resolvedThreadId: providerThreadId,
        requestedRuntimeMode: input.runtimeMode,
      }).pipe(this.runPromise);
      this.emitLifecycleEvent(context, "session/ready", `Connected to thread ${providerThreadId}`);
      this.scheduleSkillsRefresh(context, { forceReload: false });
      return { ...context.session };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start Codex session.";
      if (context) {
        this.updateSession(context, {
          status: "error",
          lastError: message,
        });
        this.emitErrorEvent(context, "session/startFailed", message);
        this.stopSession(threadId);
      } else {
        this.emitEvent({
          id: EventId.makeUnsafe(randomUUID()),
          kind: "error",
          provider: "codex",
          threadId,
          createdAt: new Date().toISOString(),
          method: "session/startFailed",
          message,
        });
      }
      throw new Error(message, { cause: error });
    }
  }

  async sendTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> {
    const context = this.requireSession(input.threadId);

    const turnInput: Array<
      { type: "text"; text: string; text_elements: [] } | { type: "image"; url: string }
    > = [];
    if (input.input) {
      turnInput.push({
        type: "text",
        text: input.input,
        text_elements: [],
      });
    }
    for (const attachment of input.attachments ?? []) {
      if (attachment.type === "image") {
        turnInput.push({
          type: "image",
          url: attachment.url,
        });
      }
    }
    if (turnInput.length === 0) {
      throw new Error("Turn input must include text or attachments.");
    }

    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing provider resume thread id.");
    }
    const turnStartParams: {
      threadId: string;
      input: Array<
        { type: "text"; text: string; text_elements: [] } | { type: "image"; url: string }
      >;
      model?: string;
      serviceTier?: string | null;
      effort?: string;
      collaborationMode?: {
        mode: "default" | "plan";
        settings: {
          model: string;
          reasoning_effort: string;
          developer_instructions: string;
        };
      };
    } = {
      threadId: providerThreadId,
      input: turnInput,
    };
    const normalizedModel = resolveCodexModelForAccount(
      normalizeCodexModelSlug(input.model ?? context.session.model),
      context.account,
    );
    if (normalizedModel) {
      turnStartParams.model = normalizedModel;
    }
    if (input.serviceTier !== undefined) {
      turnStartParams.serviceTier = input.serviceTier;
    }
    if (input.effort) {
      turnStartParams.effort = input.effort;
    }
    const collaborationMode = buildCodexCollaborationMode({
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(context.instructionContext !== undefined
        ? { instructionContext: context.instructionContext }
        : {}),
      includeResumedContext: !context.resumedContextSent,
    });
    if (!turnStartParams.model) {
      turnStartParams.model = collaborationMode.settings.model;
    }
    turnStartParams.collaborationMode = collaborationMode;

    const response = await this.sendRequest(context, "turn/start", turnStartParams);

    const turn = this.readObject(this.readObject(response), "turn");
    const turnIdRaw = this.readString(turn, "id");
    if (!turnIdRaw) {
      throw new Error("turn/start response did not include a turn id.");
    }
    const turnId = TurnId.makeUnsafe(turnIdRaw);
    const previousConfiguredModel = context.session.model;
    const nextConfiguredModel = turnStartParams.model ?? context.session.model;

    this.updateSession(context, {
      status: "running",
      ...(nextConfiguredModel !== undefined ? { model: nextConfiguredModel } : {}),
      activeTurnId: turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    });
    if (nextConfiguredModel !== undefined && nextConfiguredModel !== previousConfiguredModel) {
      const modelContextWindowTokens = lookupModelContextWindowTokens({
        provider: "codex",
        model: nextConfiguredModel,
        catalog: this.modelContextWindowCatalog,
      });
      this.emitSessionConfigured(context, {
        ...context.configuredBase,
        model: nextConfiguredModel,
        ...(modelContextWindowTokens !== undefined ? { modelContextWindowTokens } : {}),
      });
    }
    context.resumedContextSent = true;

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  }

  async runOneOffPrompt(input: {
    readonly prompt: string;
    readonly cwd?: string;
    readonly model?: string;
    readonly runtimeMode?: RuntimeMode;
    readonly providerOptions?: ProviderSessionStartInput["providerOptions"];
    readonly timeoutMs?: number;
  }): Promise<string> {
    const threadId = ThreadId.makeUnsafe(`${CODEX_ONE_OFF_THREAD_PREFIX}${randomUUID()}`);
    const timeoutMs = input.timeoutMs ?? CODEX_ONE_OFF_PROMPT_TIMEOUT_MS;
    let capturedText = "";
    const followUpPromises = new Set<Promise<unknown>>();

    let resolveCompletion: (() => void) | undefined;
    let rejectCompletion: ((error: Error) => void) | undefined;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const timer = setTimeout(() => {
      rejectCompletion?.(
        new Error(`Timed out waiting for Codex one-off prompt completion after ${timeoutMs}ms.`),
      );
    }, timeoutMs);

    const trackFollowUp = (promise: Promise<unknown>) => {
      followUpPromises.add(promise);
      promise.finally(() => {
        followUpPromises.delete(promise);
      });
    };

    const listener = (event: ProviderEvent) => {
      if (event.threadId !== threadId) {
        return;
      }

      if (event.method === "item/agentMessage/delta" && typeof event.textDelta === "string") {
        capturedText += event.textDelta;
        return;
      }

      if (event.method === "item/completed" && capturedText.length === 0) {
        const payload = asObject(event.payload);
        const item = asObject(payload?.item) ?? payload;
        const completedText = asString(item?.text);
        if (completedText) {
          capturedText = completedText;
        }
      }

      if (event.kind === "request" && event.requestId) {
        if (event.requestKind) {
          trackFollowUp(
            this.respondToRequest(threadId, event.requestId, "decline").catch(() => undefined),
          );
          return;
        }
        if (event.method === "item/tool/requestUserInput") {
          trackFollowUp(
            this.respondToUserInput(threadId, event.requestId, {}).catch(() => undefined),
          );
          return;
        }
      }

      if (event.method === "turn/completed") {
        const turn = this.readObject(event.payload, "turn");
        const status = this.readString(turn, "status");
        const errorMessage = this.readString(this.readObject(turn, "error"), "message");
        if (status !== "completed") {
          rejectCompletion?.(
            new Error(
              errorMessage ??
                (status === "failed"
                  ? "Codex one-off prompt failed."
                  : `Unexpected Codex one-off prompt status: ${status ?? "unknown"}.`),
            ),
          );
          return;
        }
        resolveCompletion?.();
      }
    };

    this.on("event", listener);

    try {
      await this.startSession({
        threadId,
        provider: "codex",
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
        runtimeMode: input.runtimeMode ?? "approval-required",
      });
      await this.sendTurn({
        threadId,
        input: input.prompt,
      });
      await completion;
      const text = capturedText.trim();
      if (text.length === 0) {
        throw new Error("Codex one-off prompt completed without returning any assistant text.");
      }
      return text;
    } finally {
      clearTimeout(timer);
      this.off("event", listener);
      if (followUpPromises.size > 0) {
        await Promise.allSettled(followUpPromises);
      }
      this.stopSession(threadId);
    }
  }

  async interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void> {
    const context = this.requireSession(threadId);
    const effectiveTurnId = turnId ?? context.session.activeTurnId;

    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!effectiveTurnId || !providerThreadId) {
      return;
    }

    await this.sendRequest(context, "turn/interrupt", {
      threadId: providerThreadId,
      turnId: effectiveTurnId,
    });
  }

  async readThread(threadId: ThreadId): Promise<CodexThreadSnapshot> {
    const context = this.requireSession(threadId);
    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing a provider resume thread id.");
    }

    const response = await this.sendRequest(context, "thread/read", {
      threadId: providerThreadId,
      includeTurns: true,
    });
    return this.parseThreadSnapshot("thread/read", response);
  }

  async rollbackThread(threadId: ThreadId, numTurns: number): Promise<CodexThreadSnapshot> {
    const context = this.requireSession(threadId);
    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing a provider resume thread id.");
    }
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      throw new Error("numTurns must be an integer >= 1.");
    }

    const response = await this.sendRequest(context, "thread/rollback", {
      threadId: providerThreadId,
      numTurns,
    });
    this.updateSession(context, {
      status: "ready",
      activeTurnId: undefined,
    });
    return this.parseThreadSnapshot("thread/rollback", response);
  }

  async respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const pendingRequest = context.pendingApprovals.get(requestId);
    if (!pendingRequest) {
      throw new Error(`Unknown pending approval request: ${requestId}`);
    }

    context.pendingApprovals.delete(requestId);
    await this.writeMessage(context, {
      id: pendingRequest.jsonRpcId,
      result: codexApprovalResponse(pendingRequest, decision),
    });

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "item/requestApproval/decision",
      turnId: pendingRequest.turnId,
      itemId: pendingRequest.itemId,
      requestId: pendingRequest.requestId,
      requestKind: pendingRequest.requestKind,
      payload: {
        requestId: pendingRequest.requestId,
        requestKind: pendingRequest.requestKind,
        decision,
      },
    });
  }

  async respondToUserInput(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const pendingRequest = context.pendingUserInputs.get(requestId);
    if (!pendingRequest) {
      throw new Error(`Unknown pending user input request: ${requestId}`);
    }

    context.pendingUserInputs.delete(requestId);
    const codexAnswers = toCodexUserInputAnswers(answers);
    await this.writeMessage(context, {
      id: pendingRequest.jsonRpcId,
      result: {
        answers: codexAnswers,
      },
    });

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "item/tool/requestUserInput/answered",
      turnId: pendingRequest.turnId,
      itemId: pendingRequest.itemId,
      requestId: pendingRequest.requestId,
      payload: {
        requestId: pendingRequest.requestId,
        answers: codexAnswers,
      },
    });
  }

  async reloadMcpConfig(threadId: ThreadId): Promise<void> {
    const context = this.requireSession(threadId);
    await this.sendRequest<Record<string, never>>(context, "config/mcpServer/reload", undefined);
  }

  stopSession(threadId: ThreadId): void {
    const context = this.sessions.get(threadId);
    if (!context) {
      return;
    }

    context.stopping = true;

    for (const pending of context.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Session stopped before request completed."));
    }
    context.pending.clear();
    context.pendingApprovals.clear();
    context.pendingUserInputs.clear();
    this.clearInitialSkillsRetry(context);

    context.output.close();
    context.writer.close();

    if (!context.child.killed) {
      killChildTree(context.child);
    }

    this.updateSession(context, {
      status: "closed",
      activeTurnId: undefined,
    });
    this.emitLifecycleEvent(context, "session/closed", "Session stopped");
    this.sessions.delete(threadId);
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values(), ({ session }) => ({
      ...session,
    }));
  }

  hasSession(threadId: ThreadId): boolean {
    return this.sessions.has(threadId);
  }

  stopAll(): void {
    for (const threadId of this.sessions.keys()) {
      this.stopSession(threadId);
    }
  }

  private requireSession(threadId: ThreadId): CodexSessionContext {
    const context = this.sessions.get(threadId);
    if (!context) {
      throw new Error(`Unknown session for thread: ${threadId}`);
    }

    if (context.session.status === "closed") {
      throw new Error(`Session is closed for thread: ${threadId}`);
    }

    return context;
  }

  private attachProcessListeners(context: CodexSessionContext): void {
    context.output.on("line", (line) => {
      this.handleStdoutLine(context, line);
    });

    context.child.stderr.on("data", (chunk: Buffer) => {
      const raw = chunk.toString();
      const lines = raw.split(/\r?\n/g);
      for (const rawLine of lines) {
        const classified = classifyCodexStderrLine(rawLine);
        if (!classified) {
          continue;
        }

        this.emitErrorEvent(context, "process/stderr", classified.message);
      }
    });

    context.child.on("error", (error) => {
      context.writer.close(error);
      const message = error.message || "codex app-server process errored.";
      this.updateSession(context, {
        status: "error",
        lastError: message,
      });
      this.emitErrorEvent(context, "process/error", message);
    });

    context.child.on("exit", (code, signal) => {
      context.writer.close(
        new Error(`codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`),
      );
      if (context.stopping) {
        return;
      }

      const message = `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
      this.updateSession(context, {
        status: "closed",
        activeTurnId: undefined,
        lastError: code === 0 ? context.session.lastError : message,
      });
      this.emitLifecycleEvent(context, "session/exited", message);
      this.sessions.delete(context.session.threadId);
    });
  }

  private handleStdoutLine(context: CodexSessionContext, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emitErrorEvent(
        context,
        "protocol/parseError",
        "Received invalid JSON from codex app-server.",
      );
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      this.emitErrorEvent(
        context,
        "protocol/invalidMessage",
        "Received non-object protocol message.",
      );
      return;
    }

    if (this.isServerRequest(parsed)) {
      this.handleServerRequest(context, parsed);
      return;
    }

    if (this.isServerNotification(parsed)) {
      this.handleServerNotification(context, parsed);
      return;
    }

    if (this.isResponse(parsed)) {
      this.handleResponse(context, parsed);
      return;
    }

    this.emitErrorEvent(
      context,
      "protocol/unrecognizedMessage",
      "Received protocol message in an unknown shape.",
    );
  }

  private handleServerNotification(
    context: CodexSessionContext,
    notification: JsonRpcNotification,
  ): void {
    const route = this.readRouteFields(notification.params);
    const textDelta =
      notification.method === "item/agentMessage/delta"
        ? this.readString(notification.params, "delta")
        : undefined;

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: notification.method,
      turnId: route.turnId,
      itemId: route.itemId,
      textDelta,
      payload: notification.params,
    });

    if (notification.method === "thread/started") {
      const providerThreadId = normalizeProviderThreadId(
        this.readString(this.readObject(notification.params)?.thread, "id"),
      );
      if (providerThreadId) {
        this.updateSession(context, { resumeCursor: { threadId: providerThreadId } });
      }
      return;
    }

    if (notification.method === "skills/changed") {
      if (context.skillRefreshInFlight) {
        context.skillRefreshPending = true;
        return;
      }

      this.scheduleSkillsRefresh(context, { forceReload: true });
      return;
    }

    if (notification.method === "turn/started") {
      const turnId = toTurnId(this.readString(this.readObject(notification.params)?.turn, "id"));
      this.updateSession(context, {
        status: "running",
        activeTurnId: turnId,
      });
      return;
    }

    if (notification.method === "turn/completed") {
      const turn = this.readObject(notification.params, "turn");
      const status = this.readString(turn, "status");
      const errorMessage = this.readString(this.readObject(turn, "error"), "message");
      this.updateSession(context, {
        status: status === "failed" ? "error" : "ready",
        activeTurnId: undefined,
        lastError: errorMessage ?? context.session.lastError,
      });
      return;
    }

    if (notification.method === "error") {
      const message = this.readString(this.readObject(notification.params)?.error, "message");
      const willRetry = this.readBoolean(notification.params, "willRetry");

      this.updateSession(context, {
        status: willRetry ? "running" : "error",
        lastError: message ?? context.session.lastError,
      });
    }
  }

  private handleServerRequest(context: CodexSessionContext, request: JsonRpcRequest): void {
    const route = this.readRouteFields(request.params);
    const approvalRequest = this.approvalRequestForMethod(request.method);
    const requestKind = approvalRequest?.requestKind;
    let requestId: ApprovalRequestId | undefined;
    if (approvalRequest) {
      requestId = ApprovalRequestId.makeUnsafe(randomUUID());
      const params = asObject(request.params);
      const requestedPermissions =
        approvalRequest.responseKind === "permissions"
          ? readCodexPermissionProfile(params?.permissions)
          : undefined;
      const pendingRequest: PendingApprovalRequest = {
        requestId,
        jsonRpcId: request.id,
        method: approvalRequest.method,
        requestKind: approvalRequest.requestKind,
        responseKind: approvalRequest.responseKind,
        ...(requestedPermissions !== undefined ? { requestedPermissions } : {}),
        threadId: context.session.threadId,
        ...(route.turnId ? { turnId: route.turnId } : {}),
        ...(route.itemId ? { itemId: route.itemId } : {}),
      };
      context.pendingApprovals.set(requestId, pendingRequest);
    }

    if (request.method === "item/tool/requestUserInput") {
      requestId = ApprovalRequestId.makeUnsafe(randomUUID());
      context.pendingUserInputs.set(requestId, {
        requestId,
        jsonRpcId: request.id,
        threadId: context.session.threadId,
        ...(route.turnId ? { turnId: route.turnId } : {}),
        ...(route.itemId ? { itemId: route.itemId } : {}),
      });
    }

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "request",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: request.method,
      turnId: route.turnId,
      itemId: route.itemId,
      requestId,
      requestKind,
      payload: request.params,
    });

    if (approvalRequest) {
      return;
    }

    if (request.method === "item/tool/requestUserInput") {
      return;
    }

    void this.writeMessage(context, {
      id: request.id,
      error: {
        code: -32601,
        message: `Unsupported server request: ${request.method}`,
      },
    }).catch((error) => {
      this.emitErrorEvent(
        context,
        "protocol/writeFailed",
        error instanceof Error ? error.message : "Failed to write protocol response.",
      );
    });
  }

  private handleResponse(context: CodexSessionContext, response: JsonRpcResponse): void {
    const key = String(response.id);
    const pending = context.pending.get(key);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    context.pending.delete(key);

    if (response.error?.message) {
      pending.reject(new Error(`${pending.method} failed: ${String(response.error.message)}`));
      return;
    }

    pending.resolve(response.result);
  }

  private async sendRequest<TResponse>(
    context: CodexSessionContext,
    method: string,
    params: unknown,
    timeoutMs = 20_000,
  ): Promise<TResponse> {
    const id = context.nextRequestId;
    context.nextRequestId += 1;

    const result = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        context.pending.delete(String(id));
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);

      context.pending.set(String(id), {
        method,
        timeout,
        resolve,
        reject,
      });
      void this.writeMessage(context, {
        method,
        id,
        params,
      }).catch((error) => {
        clearTimeout(timeout);
        context.pending.delete(String(id));
        reject(error);
      });
    });

    return result as TResponse;
  }

  private async writeMessage(context: CodexSessionContext, message: unknown): Promise<void> {
    await context.writer.write(message);
  }

  private emitSessionConfigured(
    context: CodexSessionContext,
    config: Record<string, unknown>,
  ): void {
    context.configuredBase = config;
    const configuredPayload = context.skillsLoaded
      ? {
          ...config,
          slashCommands: [...context.availableSkills],
        }
      : config;

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "session",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "session/configured",
      payload: {
        config: configuredPayload,
      },
    });
  }

  private emitLifecycleEvent(context: CodexSessionContext, method: string, message: string): void {
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "session",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitErrorEvent(context: CodexSessionContext, method: string, message: string): void {
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "error",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitEvent(event: ProviderEvent): void {
    this.emit("event", event);
  }

  private clearInitialSkillsRetry(context: CodexSessionContext): void {
    if (context.initialSkillsRetryTimeout) {
      clearTimeout(context.initialSkillsRetryTimeout);
      context.initialSkillsRetryTimeout = undefined;
    }
  }

  private scheduleInitialSkillsRetry(context: CodexSessionContext): void {
    if (
      !this.isLiveContext(context) ||
      context.skillsLoaded ||
      context.initialSkillsRetryAttempted ||
      context.initialSkillsRetryTimeout
    ) {
      return;
    }

    context.initialSkillsRetryTimeout = setTimeout(() => {
      context.initialSkillsRetryTimeout = undefined;
      if (!this.isLiveContext(context) || context.skillsLoaded) {
        return;
      }

      context.initialSkillsRetryAttempted = true;
      this.scheduleSkillsRefresh(context, { forceReload: true });
    }, CODEX_INITIAL_SKILLS_RETRY_DELAY_MS);
  }

  private scheduleSkillsRefresh(
    context: CodexSessionContext,
    options: { readonly forceReload: boolean },
  ): void {
    if (!this.isLiveContext(context)) {
      return;
    }

    if (context.skillRefreshInFlight) {
      if (options.forceReload) {
        context.skillRefreshPending = true;
      }
      return;
    }

    context.skillRefreshInFlight = true;
    void this.runSkillsRefresh(context, options).catch((error) => {
      if (!this.isLiveContext(context)) {
        return;
      }

      if (!options.forceReload && !context.skillsLoaded) {
        this.scheduleInitialSkillsRetry(context);
      }

      void Effect.logWarning("codex skills/list failed", {
        threadId: context.session.threadId,
        forceReload: options.forceReload,
        cause: error instanceof Error ? error.message : String(error),
      }).pipe(this.runPromise);
    });
  }

  private async runSkillsRefresh(
    context: CodexSessionContext,
    options: { readonly forceReload: boolean },
  ): Promise<void> {
    try {
      if (!this.isLiveContext(context)) {
        return;
      }

      const cwd = context.session.cwd ?? context.instructionContext?.cwd ?? process.cwd();
      const response = await this.sendRequest(
        context,
        "skills/list",
        {
          cwds: [cwd],
          forceReload: options.forceReload,
        },
        CODEX_SKILLS_REFRESH_TIMEOUT_MS,
      );

      if (!this.isLiveContext(context)) {
        return;
      }

      const droppedSkills: string[] = [];
      const normalizedCommands = normalizeSupportedSlashCommands(
        readEnabledSkillsFromSkillsListResponse(response, {
          onDroppedSkill: ({ reason, skill }) => {
            droppedSkills.push(`${reason}: ${describeDroppedSkill(skill)}`);
          },
        }),
      );
      if (droppedSkills.length > 0) {
        await Effect.logDebug("codex skills/list dropped malformed skills", {
          threadId: context.session.threadId,
          droppedSkills,
        }).pipe(this.runPromise);
      }

      this.clearInitialSkillsRetry(context);
      const fingerprint = fingerprintSupportedSlashCommands(normalizedCommands);
      if (context.skillsLoaded && fingerprint === context.supportedCommandsFingerprint) {
        return;
      }

      context.skillsLoaded = true;
      context.availableSkills = normalizedCommands;
      context.supportedCommandsFingerprint = fingerprint;
      if (context.configuredBase) {
        this.emitSessionConfigured(context, context.configuredBase);
      }
    } finally {
      context.skillRefreshInFlight = false;
      const shouldRerun = context.skillRefreshPending;
      context.skillRefreshPending = false;
      if (shouldRerun && this.isLiveContext(context)) {
        this.scheduleSkillsRefresh(context, { forceReload: true });
      }
    }
  }

  private isLiveContext(context: CodexSessionContext): boolean {
    return !context.stopping && this.sessions.get(context.session.threadId) === context;
  }

  private assertSupportedCodexCliVersion(input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly homePath?: string;
  }): void {
    assertSupportedCodexCliVersion(input);
  }

  private updateSession(context: CodexSessionContext, updates: Partial<ProviderSession>): void {
    context.session = {
      ...context.session,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
  }

  private approvalRequestForMethod(method: string):
    | {
        readonly method: PendingApprovalRequest["method"];
        readonly requestKind: ProviderRequestKind;
        readonly responseKind: PendingApprovalRequest["responseKind"];
      }
    | undefined {
    if (method === "item/commandExecution/requestApproval") {
      return { method, requestKind: "command", responseKind: "decision" };
    }

    if (method === "item/fileRead/requestApproval") {
      return { method, requestKind: "file-read", responseKind: "decision" };
    }

    if (method === "item/fileChange/requestApproval") {
      return { method, requestKind: "file-change", responseKind: "decision" };
    }

    if (method === "item/permissions/requestApproval") {
      return { method, requestKind: "permission", responseKind: "permissions" };
    }

    return undefined;
  }

  private parseThreadSnapshot(method: string, response: unknown): CodexThreadSnapshot {
    const responseRecord = this.readObject(response);
    const thread = this.readObject(responseRecord, "thread");
    const threadIdRaw =
      this.readString(thread, "id") ?? this.readString(responseRecord, "threadId");
    if (!threadIdRaw) {
      throw new Error(`${method} response did not include a thread id.`);
    }
    const turnsRaw =
      this.readArray(thread, "turns") ?? this.readArray(responseRecord, "turns") ?? [];
    const turns = turnsRaw.map((turnValue, index) => {
      const turn = this.readObject(turnValue);
      const turnIdRaw = this.readString(turn, "id") ?? `${threadIdRaw}:turn:${index + 1}`;
      const turnId = TurnId.makeUnsafe(turnIdRaw);
      const items = this.readArray(turn, "items") ?? [];
      return {
        id: turnId,
        items,
      };
    });

    return {
      threadId: threadIdRaw,
      turns,
    };
  }

  private isServerRequest(value: unknown): value is JsonRpcRequest {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate.method === "string" &&
      (typeof candidate.id === "string" || typeof candidate.id === "number")
    );
  }

  private isServerNotification(value: unknown): value is JsonRpcNotification {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    return typeof candidate.method === "string" && !("id" in candidate);
  }

  private isResponse(value: unknown): value is JsonRpcResponse {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    const hasId = typeof candidate.id === "string" || typeof candidate.id === "number";
    const hasMethod = typeof candidate.method === "string";
    return hasId && !hasMethod;
  }

  private readRouteFields(params: unknown): {
    turnId?: TurnId;
    itemId?: ProviderItemId;
  } {
    const route: {
      turnId?: TurnId;
      itemId?: ProviderItemId;
    } = {};

    const turnId = toTurnId(
      this.readString(params, "turnId") ?? this.readString(this.readObject(params, "turn"), "id"),
    );
    const itemId = toProviderItemId(
      this.readString(params, "itemId") ?? this.readString(this.readObject(params, "item"), "id"),
    );

    if (turnId) {
      route.turnId = turnId;
    }

    if (itemId) {
      route.itemId = itemId;
    }

    return route;
  }

  private readObject(value: unknown, key?: string): Record<string, unknown> | undefined {
    const target =
      key === undefined
        ? value
        : value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined;

    if (!target || typeof target !== "object") {
      return undefined;
    }

    return target as Record<string, unknown>;
  }

  private readArray(value: unknown, key?: string): unknown[] | undefined {
    const target =
      key === undefined
        ? value
        : value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined;
    return Array.isArray(target) ? target : undefined;
  }

  private readString(value: unknown, key: string): string | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "string" ? candidate : undefined;
  }

  private readBoolean(value: unknown, key: string): boolean | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "boolean" ? candidate : undefined;
  }
}

function brandIfNonEmpty<T extends string>(
  value: string | undefined,
  maker: (value: string) => T,
): T | undefined {
  const normalized = value?.trim();
  return normalized?.length ? maker(normalized) : undefined;
}

function normalizeProviderThreadId(value: string | undefined): string | undefined {
  return brandIfNonEmpty(value, (normalized) => normalized);
}

function readCodexProviderOptions(input: CodexAppServerStartSessionInput): {
  readonly binaryPath?: string;
  readonly homePath?: string;
} {
  const options = input.providerOptions?.codex;
  if (!options) {
    return {};
  }
  return {
    ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}),
    ...(options.homePath ? { homePath: options.homePath } : {}),
  };
}

export function assertSupportedCodexCliVersion(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly homePath?: string;
}): void {
  const codexHomePath = resolveCodexHome(input);
  const result = spawnSync(
    input.binaryPath,
    prependCodexCliTelemetryDisabledConfig(["--version"]),
    {
      cwd: input.cwd,
      env: buildProviderChildProcessEnv(
        process.env,
        codexHomePath ? { CODEX_HOME: codexHomePath } : undefined,
      ),
      encoding: "utf8",
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CODEX_VERSION_CHECK_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    },
  );

  if (result.error) {
    const lower = result.error.message.toLowerCase();
    if (
      lower.includes("enoent") ||
      lower.includes("command not found") ||
      lower.includes("not found")
    ) {
      throw new Error(`Codex CLI (${input.binaryPath}) is not installed or not executable.`);
    }
    throw new Error(
      `Failed to execute Codex CLI version check: ${result.error.message || String(result.error)}`,
    );
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    const detail = stderr.trim() || stdout.trim() || `Command exited with code ${result.status}.`;
    throw new Error(`Codex CLI version check failed. ${detail}`);
  }

  const parsedVersion = parseCodexCliVersion(`${stdout}\n${stderr}`);
  if (parsedVersion && !isCodexCliVersionSupported(parsedVersion)) {
    throw new Error(formatCodexCliUpgradeMessage(parsedVersion));
  }
}

function readResumeCursorThreadId(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const rawThreadId = (resumeCursor as Record<string, unknown>).threadId;
  return typeof rawThreadId === "string" ? normalizeProviderThreadId(rawThreadId) : undefined;
}

function readResumeThreadId(input: CodexAppServerStartSessionInput): string | undefined {
  return readResumeCursorThreadId(input.resumeCursor);
}

function toTurnId(value: string | undefined): TurnId | undefined {
  return brandIfNonEmpty(value, TurnId.makeUnsafe);
}

function toProviderItemId(value: string | undefined): ProviderItemId | undefined {
  return brandIfNonEmpty(value, ProviderItemId.makeUnsafe);
}
