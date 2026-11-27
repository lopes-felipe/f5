import { probeCodexCliVersion } from "../../codex/cliVersionProbe.ts";
import { ProviderLineReader } from "../../codex/lineReader.ts";
import { CODEX_BROWSER_RESUME_TOOL } from "../codexBrowserResume";

import type { ProviderAdapterSessionStartInput } from "../Services/ProviderAdapter.ts";
import type { CodexControlMcpServerStatus } from "../../codex/CodexControlClient.ts";
import {
  supportsCodexRelease5,
  supportsCodexRelease6,
} from "@t3tools/shared/providerRuntimeCapabilities";
import {
  classifyReadOnlyShellCommand,
  isShellProgram,
  unwrapShellInvocation,
} from "../readOnlyWorkflowShell.ts";
import {
  codexCommandApprovalDecision,
  type CodexCommandApprovalOffer,
} from "../../codex/commandApprovalOffer.ts";
import { describeMcpElicitation, mcpElicitationResponse } from "../../codex/mcpElicitation.ts";
import { ElicitationRegistry } from "../elicitationRegistry.ts";
import { type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  ApprovalRequestId,
  type CodexMcpServerEntry,
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelCapabilities,
  type ProjectMemory,
  ProviderItemId,
  ProviderRequestKind,
  type ProviderUserInputAnswers,
  type ReadOnlyEnforcement,
  ThreadId,
  type ThreadSessionNotes,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderSession,
  type ProviderSessionStartInput,
  RuntimeMode,
  ProviderInteractionMode,
} from "@t3tools/contracts";
import { isIgnorableCodexProcessStderrMessage } from "@t3tools/shared/codexStderr";
import {
  normalizeModelSlug,
  resolveCodexEffectiveReasoningEffort,
  resolveModelCapabilities,
} from "@t3tools/shared/model";
import { assertNever } from "@t3tools/shared/exhaustive";
import { killProcessTree } from "@t3tools/shared/processTree";

import {
  buildCodexAdditionalContext,
  buildCodexModeInstructions,
  type CodexAdditionalContextEntry,
  type SharedInstructionInput,
} from "../sharedAssistantContract";
import { resolveCodexCommand } from "../codexExecutable.ts";
import {
  fingerprintSupportedSlashCommands,
  type SupportedSlashCommand,
} from "../supportedSlashCommands";
import { type JsonRpcStdinWriter } from "../../codex/JsonRpcStdinWriter.ts";
import { resolveCodexHome } from "../../os-jank.ts";

export function buildCodexSampleParams(
  threadId: string,
  expectedTurnId: string,
  prompt: string,
  effort?: string,
) {
  return { threadId, expectedTurnId, prompt, ...(effort ? { effort } : {}) };
}

export function buildCodexReadMarkParams(threadId: string, expectedRevision: string) {
  return { threadId, expectedRevision, operation: { type: "read" as const } };
}

export function buildCodexMemoryReadParams(threadId: string) {
  return { threadId };
}

export function buildCodexUsageReadParams(threadId: string) {
  return { threadId };
}

export function buildCodexGoalPauseParams(threadId: string, origin: "user" | "automatic") {
  return { threadId, status: "paused" as const, origin };
}

export function buildCodexGoalClearParams(threadId: string) {
  return { threadId, origin: "user" as const };
}

export type PendingRequestKey = string;

export interface PendingRequest {
  method: string;
  wasWritten?: boolean;
  cancelWrite?: () => void;
  timeout: ReturnType<typeof setTimeout> | undefined;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface PendingApprovalRequest {
  requestId: ApprovalRequestId;
  jsonRpcId: string | number;
  method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
    | "item/fileRead/requestApproval"
    | "item/permissions/requestApproval"
    | "mcpServer/elicitation/request"
    | "applyPatchApproval"
    | "execCommandApproval";
  requestKind: ProviderRequestKind;
  responseKind: "decision" | "permissions" | "legacy-decision" | "mcp-elicitation";
  elicitation?: unknown;
  /** Decisions and execpolicy prefix the command request offered; responses must match. */
  commandOffer?: CodexCommandApprovalOffer;
  requestedPermissions?: Record<string, unknown>;
  /** The session allowance read when the request arrived; a session answer adds to it. */
  sessionAllowance?: Set<ProviderRequestKind>;
  threadId: ThreadId;
  turnId?: TurnId;
  itemId?: ProviderItemId;
}

export interface NativeRequestCorrelation {
  readonly nativeRequestId: string;
  readonly requestId: ApprovalRequestId;
  readonly method: string;
  readonly requestKind?: ProviderRequestKind;
  readonly responseChannel: "approval" | "user-input" | "elicitation";
  readonly turnId?: TurnId;
  readonly itemId?: ProviderItemId;
  resolvedLocally: boolean;
}

export interface PendingUserInputRequest {
  requestId: ApprovalRequestId;
  jsonRpcId: string | number;
  threadId: ThreadId;
  turnId?: TurnId;
  itemId?: ProviderItemId;
}

export interface CodexUserInputAnswer {
  answers: string[];
}

export interface CodexSessionContext {
  browserResume?: () => Promise<unknown>;
  browserResumeRegistered?: boolean;
  mcpCalls?: Set<string>;
  mcpCallOwners?: Map<string, { threadId: string; turnId: string }>;
  retiredMcpTurns?: Set<string>;
  retiredMcpThreads?: Set<string>;
  mcpEventIdentity?: ProviderAdapterSessionStartInput["mcpEventIdentity"];
  session: ProviderSession;
  mcpStartupStatuses?: Map<string, CodexControlMcpServerStatus>;
  mcpObservationContext?: object;
  account: CodexAccountSnapshot;
  child: ChildProcessWithoutNullStreams;
  output: ProviderLineReader;
  writer: JsonRpcStdinWriter;
  pending: Map<PendingRequestKey, PendingRequest>;
  pendingApprovals: Map<ApprovalRequestId, PendingApprovalRequest>;
  /**
   * Approval kinds the user chose "Always allow this session" for. Codex's own
   * acceptForSession only skips the exact command or patch it answered, so every
   * new command would ask again. A different runtime mode ends the allowance, and
   * so does the session closing, like Codex's own session approvals.
   */
  sessionApprovals?: { runtimeMode: RuntimeMode; kinds: Set<ProviderRequestKind> };
  memoryThreadIds?: Set<string>;
  pendingUserInputs: Map<ApprovalRequestId, PendingUserInputRequest>;
  /** MCP form/URL requests answered privately; optional for hand-built test contexts. */
  elicitations?: ElicitationRegistry;
  nativeRequestCorrelations: Map<string, NativeRequestCorrelation>;
  instructionContext?: Partial<SharedInstructionInput>;
  configuredBase?: Record<string, unknown>;
  workflowExecutionProfile?: ProviderSessionStartInput["workflowExecutionProfile"];
  /** How the read-only workflow stage runs Codex; see `CodexReadOnlyMode`. */
  readOnlyMode?: CodexReadOnlyMode;
  modelContextWindowCatalog: ReadonlyMap<string, number>;
  /** Capabilities this session's `model/list` reported, keyed by slug. */
  reportedModelCapabilities?: ReadonlyMap<string, ModelCapabilities>;
  availableSkills: ReadonlyArray<SupportedSlashCommand>;
  supportedCommandsFingerprint: string;
  skillsLoaded: boolean;
  skillRefreshInFlight: boolean;
  skillRefreshPending: boolean;
  initialSkillsRetryTimeout: ReturnType<typeof setTimeout> | undefined;
  initialSkillsRetryAttempted: boolean;
  resumedContextSent: boolean;
  /** The `additionalContext` of the latest `turn/start`, restored after compaction. */
  lastAdditionalContext?: Record<string, CodexAdditionalContextEntry> | undefined;
  cliVersion?: string | null;
  readState?: { firstUnread: unknown; revision: string } | null;
  readMarkInFlight?: boolean;
  sampleRequestId?: number;
  sampleCompletion?: Promise<unknown>;
  sampleCancellation?: Promise<void>;
  samplePreparing?: boolean;
  sampleCancelled?: boolean;
  protocolDecodeFailureCount: number;
  nextRequestId: number;
  stopping: boolean;
  phase?: "accepting" | "draining" | "closed";
  beginDrain?: (error: Error, method: string, message: string) => void;
  turnPaginationUnsupported?: boolean;
  /** Set once the CLI rejects `thread/revert` as unknown; rollback then uses `thread/rollback`. */
  revertUnsupported?: boolean;
  rollbackUnsupported?: boolean;
  unsettledFork?: boolean;
  legacyHistoryThreadIds?: Set<string>;
  lastProviderTitle?: string;
  reviewThreadIds?: Set<string>;
  closedNativeThreadIds?: Set<string>;
  reviewOperationActive?: boolean;
  nativeReviewTurnId?: string;
  nativeGoalActive?: boolean;
  nativeGoalBudget?: number;
  nativeGoalPauseInFlight?: boolean;
  requestedRuntime?: Record<string, unknown>;
  /**
   * Whether F5 put a service tier on this provider thread. A turn clears the
   * tier only then, so a tier from the user's `config.toml` is left alone.
   */
  serviceTierApplied?: boolean;
  usageServiceTiers?: Map<TurnId, string>;
  /** Resolve a startup selection only after the opened thread's catalog is known. */
  deferredServiceTier?: string | undefined;
  childThreadIds?: Set<string>;
  forkNotifications?: JsonRpcNotification[] | undefined;
  forkNotificationOverflow?: boolean;
  /** Set when a count-based `thread/rollback` got no response and may still apply. */
  unsettledCountRollback?: boolean;
}

export interface JsonRpcError {
  code?: number;
  message?: string;
  data?: unknown;
}

export class CodexJsonRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
    readonly data?: unknown,
    readonly rawMessage: string = message,
  ) {
    super(`${method} failed: ${message}`);
  }
}

/**
 * True when the app-server rejected `method` because it does not know it.
 * Older servers answer -32601; newer ones fail request decoding with
 * "unknown variant `<method>`" instead. Either way nothing was executed.
 */
export function isUnknownMethodError(error: unknown, method: string): boolean {
  return (
    error instanceof CodexJsonRpcError &&
    error.method === method &&
    (error.code === -32601 || error.message.includes(`unknown variant \`${method}\``))
  );
}

export interface JsonRpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export type CodexPlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "team"
  | "business"
  | "enterprise"
  | "edu"
  | "unknown";

export interface CodexAccountSnapshot {
  readonly type: "apiKey" | "chatgpt" | "unknown";
  readonly planType: CodexPlanType | null;
  readonly sparkEnabled: boolean;
}

export interface CodexAppServerSendTurnInput {
  readonly cyberAccessProgram?: "standard" | "daybreakBlue" | "daybreakRed";
  /** Ordinary files remain in attachment context; native audio is an optional extra. */
  audioFiles?: ReadonlyArray<string>;
  readonly expectedTurnId?: TurnId;
  readonly threadId: ThreadId;
  readonly input?: string;
  readonly attachments?: ReadonlyArray<
    | { type: "image"; url: string }
    | { type: "localImage"; path: string }
    | { type: "localAudio"; path: string }
  >;
  readonly model?: string;
  readonly serviceTier?: string | null;
  readonly effort?: string;
  readonly interactionMode?: ProviderInteractionMode;
}

export interface CodexAppServerStartSessionInput {
  readonly browserResume?: () => Promise<unknown>;
  readonly mcpEventIdentity?: ProviderAdapterSessionStartInput["mcpEventIdentity"];
  readonly effectiveModelCapabilities?: ReadonlyMap<string, ModelCapabilities>;
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
  readonly mcpEnvironment?: Record<string, string>;
  /** Appended to developer instructions (absolute, F5-verified integration paths). */
  readonly integrationInstructions?: ReadonlyArray<string>;
  readonly mcpOAuthCallbackPort?: number;
  readonly mcpOAuthCallbackUrl?: string;
  readonly resumeCursor?: unknown;
  readonly providerOptions?: ProviderSessionStartInput["providerOptions"];
  readonly processEnvironment?: NodeJS.ProcessEnv;
  readonly runtimeMode: RuntimeMode;
  readonly workflowExecutionProfile?: ProviderSessionStartInput["workflowExecutionProfile"];
  /** How a read-only workflow stage is enforced; `policy` where Codex's sandbox can't start. */
  readonly readOnlyEnforcement?: ReadOnlyEnforcement;
  /** Internal: launch the app-server with Codex plugins (and marketplace auto-upgrade) off. */
  readonly disablePlugins?: boolean;
  /**
   * Internal: the rules-free Codex home a read-only workflow stage runs in (CodexReadOnlyHome.ts).
   * Materialized from the instance's home before launch; only used with `workflowExecutionProfile`.
   */
  readonly readOnlyHomePath?: string;
  /** Internal: working directory of the app-server process, when it differs from the thread cwd. */
  readonly processCwd?: string;
}

export interface CodexThreadTurnSnapshot {
  id: TurnId;
  items: unknown[];
}

export interface CodexThreadSnapshot {
  historyCoverage?: "complete" | "partial";
  threadId: string;
  turns: CodexThreadTurnSnapshot[];
}

export const CODEX_JSON_RPC_TIMEOUT_MS = 20_000;
/** How long a closed stdout waits for the process exit status before ending the session. */
export const CODEX_EXIT_STATUS_GRACE_MS = 250;
export const CODEX_STDOUT_ENDED_MESSAGE =
  "codex app-server closed its output stream; the session was ended.";
export const CODEX_THREAD_OPEN_TIMEOUT_MS = 60_000;
/** Internal event methods for private MCP form/URL requests (value-free payloads). */
export const CODEX_ELICITATION_OPENED_METHOD = "f5/elicitation/opened";
export const CODEX_ELICITATION_SETTLED_METHOD = "f5/elicitation/settled";

export function codexRequestTimeoutMs(method: string): number {
  // Inference ends on response, cancellation or exit, not the control RPC clock.
  // Its stdin write still has the normal bounded deadline.
  if (method === "thread/sample") return 0;
  return method === "thread/start" || method === "thread/resume"
    ? CODEX_THREAD_OPEN_TIMEOUT_MS
    : CODEX_JSON_RPC_TIMEOUT_MS;
}

export const ANSI_ESCAPE_CHAR = String.fromCharCode(27);
export const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;]*m`, "g");
export const CODEX_STDERR_LOG_REGEX =
  /^\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+\S+:\s+(.*)$/;
export const RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS = [
  "not found",
  "missing thread",
  "no such thread",
  "unknown thread",
  "does not exist",
  "no rollout found",
];
export const CODEX_SPARK_FALLBACK_MODEL = "gpt-5.3-codex";
export const CODEX_SPARK_MODEL = "gpt-5.3-codex-spark";
export const CODEX_SPARK_DISABLED_PLAN_TYPES = new Set<CodexPlanType>(["free", "go", "plus"]);
export const CODEX_ONE_OFF_THREAD_PREFIX = "one-off:";
/** A warm one-off app-server stops after this long without a prompt. */
export const CODEX_ONE_OFF_WORKER_IDLE_MS = 5 * 60_000;
/** Retire a warm one-off app-server after this many prompts to bound its memory. */
export const CODEX_ONE_OFF_WORKER_MAX_PROMPTS = 50;
export const CODEX_SKILLS_REFRESH_TIMEOUT_MS = 5_000;
export const CODEX_INITIAL_SKILLS_RETRY_DELAY_MS = 2_000;
export const CODEX_NATIVE_REQUEST_CORRELATION_CAPACITY = 256;
export const EMPTY_SUPPORTED_COMMANDS_FINGERPRINT = fingerprintSupportedSlashCommands([]);

export function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function readNotificationProviderThreadId(params: unknown): string | undefined {
  const payload = asObject(params);
  const thread = asObject(payload?.thread);
  const message = asObject(payload?.msg);
  return normalizeProviderThreadId(
    asString(payload?.threadId) ??
      asString(payload?.thread_id) ??
      asString(thread?.id) ??
      asString(message?.threadId) ??
      asString(message?.thread_id),
  );
}

export function readCodexPermissionProfile(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function codexPermissionApprovalResponse(
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

/**
 * The answer to a command or file-change request the user already allowed for the session,
 * or null when the request does not offer a session (or plain) approval and must ask.
 */
export function codexSessionAllowedResponse(
  responseKind: PendingApprovalRequest["responseKind"],
  commandOffer: CodexCommandApprovalOffer | undefined,
): Record<string, unknown> | null {
  if (responseKind === "legacy-decision") return { decision: "approved_for_session" };
  if (responseKind !== "decision") return null;
  const offered = commandOffer?.decisions;
  if (!offered || offered.has("acceptForSession")) return { decision: "acceptForSession" };
  return offered.has("accept") ? { decision: "accept" } : null;
}

export function codexApprovalResponse(
  pendingRequest: Pick<
    PendingApprovalRequest,
    "responseKind" | "elicitation" | "commandOffer" | "requestedPermissions"
  >,
  decision: ProviderApprovalDecision,
): Record<string, unknown> {
  if (
    decision === "acceptAlways" &&
    pendingRequest.responseKind !== "mcp-elicitation" &&
    !pendingRequest.commandOffer?.execpolicyAmendment
  )
    throw new Error("Persistent approval is only supported when the provider offered it.");
  switch (pendingRequest.responseKind) {
    case "mcp-elicitation": {
      if (
        !describeMcpElicitation(pendingRequest.elicitation).approvalOptions.some(
          (option) => option.decision === decision,
        )
      )
        throw new Error("This MCP request does not support the selected approval.");
      return mcpElicitationResponse(pendingRequest.elicitation, decision);
    }
    case "decision":
      return pendingRequest.commandOffer
        ? { decision: codexCommandApprovalDecision(pendingRequest.commandOffer, decision) }
        : { decision };
    case "permissions":
      return codexPermissionApprovalResponse(decision, pendingRequest.requestedPermissions);
    case "legacy-decision":
      return { decision: legacyCodexApprovalDecision(decision) };
    default: {
      const exhaustive: never = pendingRequest.responseKind;
      return exhaustive;
    }
  }
}

export function legacyCodexApprovalDecision(
  decision: ProviderApprovalDecision,
): "approved" | "approved_for_session" | "denied" | "abort" {
  switch (decision) {
    case "accept":
      return "approved";
    case "acceptForSession":
      return "approved_for_session";
    case "acceptAlways":
      throw new Error("Persistent approval is not supported by legacy Codex requests.");
    case "decline":
      return "denied";
    case "cancel":
      return "abort";
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

export function describeDroppedSkill(skill: Record<string, unknown>): string {
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
    sparkEnabled: false,
  };
}

export function mapCodexRuntimeMode(runtimeMode: RuntimeMode): {
  readonly approvalPolicy: "untrusted" | "on-request" | "never";
  readonly sandbox: "read-only" | "workspace-write" | "danger-full-access";
  readonly approvalsReviewer: "user" | "auto_review";
} {
  switch (runtimeMode) {
    case "approval-required":
      return {
        approvalPolicy: "untrusted",
        sandbox: "read-only",
        approvalsReviewer: "user",
      };
    case "auto-accept-edits":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "user",
      };
    case "auto":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "auto_review",
      };
    case "full-access":
      return {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
      };
    default:
      return assertNever(runtimeMode, "Codex runtime mode");
  }
}

/**
 * Config overrides sent with every thread start, resume and fork, layered above
 * the user's and project's `config.toml`. Codex waits this long for MCP servers
 * before the first model request and leaves out any server still starting
 * (default 1 s, too short for cold `npx`/`uvx` servers). A hung server delays
 * only the first turn of a session, not its 30 s startup timeout.
 */
/** The sandbox every turn of a read-only workflow stage runs under: no writes, no network. */
export const CODEX_READ_ONLY_TURN_SANDBOX_POLICY = {
  type: "readOnly",
  networkAccess: false,
} as const;

const CODEX_POLICY_TURN_SANDBOX_POLICY = { type: "dangerFullAccess" } as const;

/**
 * How a read-only workflow stage runs Codex (docs/reviews/read-only-live-gates.md, "Codex read-only
 * escalation"):
 *
 * - `sandbox`: Codex's read-only sandbox, and Codex never asks. Where that sandbox can't start
 *   (F5's macOS desktop backend already runs inside one, see `nestedSandboxProbe.ts`), shell
 *   commands fail closed and the stage reads through F5's forge tools.
 * - `ask-every-command`: no sandbox, and Codex asks before every command outside its own
 *   read-only safe list. F5 answers each request with its command classifier
 *   (`codexReadOnlyPolicyDecision`); edits and permission requests are refused.
 * - `ask-on-escalation`: Codex's read-only sandbox with `on-request`, for organisations whose
 *   requirements forbid `untrusted`. Where the sandbox can't start, Codex asks to rerun its own
 *   safe commands outside it, and the model escalates any other command it needs. F5 answers those
 *   requests exactly as in `ask-every-command`; commands nobody asks about fail closed.
 */
export type CodexReadOnlyMode = "sandbox" | "ask-every-command" | "ask-on-escalation";

export function codexReadOnlyStagePolicy(mode: CodexReadOnlyMode | undefined) {
  switch (mode) {
    case "ask-every-command":
      return {
        approvalPolicy: "untrusted" as const,
        sandbox: "danger-full-access" as const,
        sandboxPolicy: CODEX_POLICY_TURN_SANDBOX_POLICY,
        approvalsReviewer: "user" as const,
      };
    case "ask-on-escalation":
      return {
        approvalPolicy: "on-request" as const,
        sandbox: "read-only" as const,
        sandboxPolicy: CODEX_READ_ONLY_TURN_SANDBOX_POLICY,
        approvalsReviewer: "user" as const,
      };
    default:
      return {
        approvalPolicy: "never" as const,
        sandbox: "read-only" as const,
        sandboxPolicy: CODEX_READ_ONLY_TURN_SANDBOX_POLICY,
        // Anything that still asks reaches F5, which refuses it in a workflow stage. Codex's
        // auto-reviewer could approve it.
        approvalsReviewer: "user" as const,
      };
  }
}

/** The enforcement a stage in this mode has: only `sandbox` relies on Codex's sandbox alone. */
export function codexReadOnlyModeEnforcement(mode: CodexReadOnlyMode): ReadOnlyEnforcement {
  return mode === "sandbox" ? "sandbox" : "policy";
}

/**
 * Why a thread/start or thread/resume response shows that Codex did not apply the read-only
 * stage policy, or undefined when it did. Codex reports the effective policy as `sandbox` (older
 * releases used `sandboxPolicy`); a release that reports neither cannot be checked here and is
 * still bound by the per-turn `sandboxPolicy`. In `ask-every-command` only the approval policy
 * matters: F5's answers are the enforcement, so Codex must ask.
 */
export function codexReadOnlyThreadPolicyViolation(
  response: unknown,
  mode?: CodexReadOnlyMode,
): string | undefined {
  const record = asObject(response);
  if (!record) return undefined;
  const expectedApprovalPolicy = codexReadOnlyStagePolicy(mode).approvalPolicy;
  const sandbox = asObject(record.sandbox) ?? asObject(record.sandboxPolicy);
  if (sandbox && mode !== "ask-every-command") {
    const type = asString(sandbox.type) ?? "unknown";
    if (type !== "readOnly") return `reported sandbox ${type}`;
    if (sandbox.networkAccess !== false && sandbox.networkAccess !== undefined)
      return "reported sandbox readOnly with network access";
  }
  const approvalPolicy = record.approvalPolicy;
  if (approvalPolicy !== undefined && approvalPolicy !== expectedApprovalPolicy)
    return `reported approval policy ${typeof approvalPolicy === "string" ? approvalPolicy : "granular"}`;
  return undefined;
}

/** What Codex's managed requirements allow, as far as a read-only stage cares. */
export interface CodexReadOnlyRequirements {
  /** Undefined when nothing restricts them. Granular entries are ignored: F5 never asks for one. */
  readonly allowedApprovalPolicies?: ReadonlySet<string>;
  readonly allowedSandboxModes?: ReadonlySet<string>;
}

const stringSet = (value: unknown): ReadonlySet<string> | undefined => {
  const entries = asArray(value);
  return entries
    ? new Set(entries.filter((entry): entry is string => typeof entry === "string"))
    : undefined;
};

/** Reads a `configRequirements/read` response; undefined when the CLI reports no requirements. */
export function readCodexRequirements(response: unknown): CodexReadOnlyRequirements | undefined {
  const requirements = asObject(asObject(response)?.requirements);
  if (!requirements) return undefined;
  const allowedApprovalPolicies = stringSet(requirements.allowedApprovalPolicies);
  const allowedSandboxModes = stringSet(requirements.allowedSandboxModes);
  return {
    ...(allowedApprovalPolicies ? { allowedApprovalPolicies } : {}),
    ...(allowedSandboxModes ? { allowedSandboxModes } : {}),
  };
}

/**
 * The mode a read-only stage runs in under those requirements. A sandboxed stage stays sandboxed.
 * A policy-enforced stage needs Codex to ask:
 *
 * - `ask-every-command` needs `untrusted` and `danger-full-access`. An organisation that forbids
 *   either (for example `allowed_approval_policies = ["on-request", "never"]`) would make Codex
 *   fall back to something that runs commands without asking.
 * - Otherwise `on-request` gives `ask-on-escalation`.
 * - Otherwise `never` gives `sandbox`: shell commands fail closed where the sandbox can't start.
 * - Anything else keeps `ask-every-command`, and the fail-closed thread check refuses what Codex
 *   doesn't apply.
 */
export function codexReadOnlyModeUnderRequirements(
  requested: ReadOnlyEnforcement,
  requirements: CodexReadOnlyRequirements | undefined,
): CodexReadOnlyMode {
  if (requested !== "policy") return "sandbox";
  const approvals = requirements?.allowedApprovalPolicies;
  const sandboxes = requirements?.allowedSandboxModes;
  const allowsApproval = (policy: string) => !approvals || approvals.has(policy);
  const allowsSandbox = (mode: string) => !sandboxes || sandboxes.has(mode);
  if (allowsApproval("untrusted") && allowsSandbox("danger-full-access"))
    return "ask-every-command";
  if (allowsApproval("on-request") && allowsSandbox("read-only")) return "ask-on-escalation";
  if (allowsApproval("never") && allowsSandbox("read-only")) return "sandbox";
  return "ask-every-command";
}

/** Emitted when F5 refused an approval request itself; the adapter reports it auto-declined. */
export const CODEX_READ_ONLY_REFUSED_METHOD = "f5/readOnly/refused";

/**
 * Emitted when a read-only stage's enforcement differs from what F5 recorded at start, because
 * Codex's managed requirements left only the sandbox (`codexReadOnlyModeUnderRequirements`).
 * Payload: `{ enforcement }`.
 */
export const CODEX_READ_ONLY_ENFORCEMENT_CHANGED_METHOD = "f5/readOnly/enforcementChanged";

const SHELL_ESCALATION_FIELDS = [
  "additionalPermissions",
  "networkApprovalContext",
  "proposedNetworkPolicyAmendments",
] as const;

const presentField = (value: unknown) =>
  value != null && !(Array.isArray(value) && value.length === 0);

/**
 * F5's answer to a Codex approval request in a policy-enforced read-only stage, or undefined to
 * leave it to the normal flow (MCP elicitations, which the stage refuses as a violation).
 * Commands are accepted only when F5's classifier proves them read-only, after unwrapping the
 * `/bin/zsh -lc '…'` Codex reports them in; a command asking for more permissions or network is
 * refused, and so is input for a running terminal (`writeStdin`) or a managed checkpoint
 * (`humanCommand`). File reads are accepted; file changes and permission requests are refused.
 * The answer is always a plain accept or decline: an execpolicy amendment or a session allowance
 * would outlive the request.
 */
export function codexReadOnlyPolicyDecision(
  method: string,
  params: unknown,
): { readonly decision: "accept" | "decline"; readonly reason?: string } | undefined {
  const record = asObject(params);
  switch (method) {
    case "item/fileRead/requestApproval":
      return { decision: "accept" };
    case "item/fileChange/requestApproval":
    case "applyPatchApproval":
      return { decision: "decline", reason: "file changes are not allowed" };
    case "item/permissions/requestApproval":
      return { decision: "decline", reason: "more permissions are not allowed" };
    case "item/commandExecution/requestApproval":
    case "execCommandApproval": {
      const kind = record?.kind;
      if (kind !== undefined && kind !== null && kind !== "command")
        return { decision: "decline", reason: `${String(kind)} requests are not allowed` };
      if (SHELL_ESCALATION_FIELDS.some((field) => presentField(record?.[field])))
        return { decision: "decline", reason: "more permissions are not allowed" };
      const command = codexApprovalCommand(record?.command);
      if (command === undefined) return { decision: "decline", reason: "no command to check" };
      const verdict = classifyReadOnlyShellCommand(unwrapShellInvocation(command));
      return verdict.readOnly
        ? { decision: "accept" }
        : { decision: "decline", reason: verdict.reason };
    }
    default:
      return undefined;
  }
}

/**
 * The command string of a request: v2 sends one string, the legacy request an argv. An argv is
 * checked only in its `[shell, "-c" | "-lc", script]` form, or as a single literal program call.
 */
function codexApprovalCommand(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() ? value : undefined;
  const argv = asArray(value);
  if (!argv || argv.length === 0 || !argv.every((entry) => typeof entry === "string"))
    return undefined;
  const words = argv as ReadonlyArray<string>;
  if (words.length === 3 && (words[1] === "-c" || words[1] === "-lc") && isShellProgram(words[0]!))
    return words[2];
  // Anything a shell would read specially stays a refusal rather than a guess at quoting.
  return words.every((word) => /^[\w@%+=:,./-][\w@%+=:,./~^-]*$/.test(word))
    ? words.join(" ")
    : undefined;
}

export const CODEX_THREAD_CONFIG = {
  mcp_optional_startup_grace_ms: 10_000,
  "features.concurrent_reasoning_summaries": true,
} as const;

export function buildCodexThreadOpenRequestParams(input: {
  readonly cwd?: string;
  readonly model?: string;
  readonly resumeThreadId?: string;
  readonly cliVersion?: string | null;
  readonly runtimeMode: RuntimeMode;
  readonly workflowExecutionProfile?: ProviderSessionStartInput["workflowExecutionProfile"];
  readonly readOnlyMode?: CodexReadOnlyMode;
  readonly serviceTier?: string;
  readonly browserResume?: boolean;
}) {
  const stagePolicy = input.workflowExecutionProfile
    ? codexReadOnlyStagePolicy(input.readOnlyMode)
    : undefined;
  const overrides = {
    model: input.model ?? null,
    ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
    cwd: input.cwd ?? null,
    config: CODEX_THREAD_CONFIG,
    // Same as every turn (buildCodexTurnStartParams).
    ...(stagePolicy
      ? {
          approvalPolicy: stagePolicy.approvalPolicy,
          sandbox: stagePolicy.sandbox,
          approvalsReviewer: stagePolicy.approvalsReviewer,
        }
      : mapCodexRuntimeMode(input.runtimeMode)),
  };
  return {
    start: {
      ...overrides,
      experimentalRawEvents: false,
      ...(input.browserResume &&
      input.runtimeMode === "full-access" &&
      supportsCodexRelease5(input.cliVersion)
        ? { dynamicTools: [CODEX_BROWSER_RESUME_TOOL] }
        : {}),
    },
    ...(input.resumeThreadId
      ? {
          resume: {
            ...overrides,
            threadId: input.resumeThreadId,
            excludeTurns: true,
          },
        }
      : {}),
  };
}

export function isCodexLegacyHistoryRevertError(error: unknown): boolean {
  return (
    error instanceof CodexJsonRpcError &&
    error.method === "thread/revert" &&
    error.message.includes("thread/revert only supports paginated threads")
  );
}

export function selectCodexRewindStrategy(
  flags: {
    readonly revertUnsupported?: boolean;
    readonly rollbackUnsupported?: boolean;
    readonly legacyHistoryThreadIds?: ReadonlySet<string>;
  },
  providerThreadId: string,
): "revert" | "rollback" | "fork" {
  if (!flags.revertUnsupported && !flags.legacyHistoryThreadIds?.has(providerThreadId))
    return "revert";
  return flags.rollbackUnsupported ? "fork" : "rollback";
}

export function buildCodexThreadRevertParams(threadId: string, beforeTurnId: string) {
  return { threadId, beforeTurnId };
}

export function buildCodexThreadForkParams(
  input: Parameters<typeof buildCodexThreadOpenRequestParams>[0],
  threadId: string,
  beforeTurnId?: string,
) {
  const {
    experimentalRawEvents: _rawEvents,
    dynamicTools: _dynamicTools,
    ...overrides
  } = buildCodexThreadOpenRequestParams(input).start;
  return {
    ...overrides,
    threadId,
    ...(beforeTurnId !== undefined ? { beforeTurnId } : {}),
    excludeTurns: true,
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

const forceKillTimers = new WeakMap<
  ChildProcessWithoutNullStreams,
  ReturnType<typeof setTimeout>
>();

export function killChildTree(child: ChildProcessWithoutNullStreams): void {
  killProcessTree(child, { isGroupLeader: false, graceful: true });
  if (forceKillTimers.has(child)) return;
  const forceKill = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      killProcessTree(child, { isGroupLeader: false, graceful: false });
    }
  }, 2_000);
  forceKillTimers.set(child, forceKill);
  forceKill.unref();
  child.once("exit", () => {
    clearTimeout(forceKill);
    forceKillTimers.delete(child);
  });
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

export function resolveCodexServiceTier(
  requested: string | null | undefined,
  capabilities?: ModelCapabilities,
): string | null | undefined {
  if (requested !== "fast") return requested;
  if (capabilities && !resolveModelCapabilities("codex", undefined, capabilities).supportsFastMode)
    return null;
  return (
    capabilities?.serviceTiers?.find((tier) => tier.id === "fast")?.id ??
    capabilities?.serviceTiers?.find((tier) => tier.id === "priority")?.id ??
    "fast"
  );
}

export function buildCodexTurnStartParams(
  input: CodexAppServerSendTurnInput,
  state: {
    readonly providerThreadId: string;
    readonly model?: string | undefined;
    readonly account: CodexAccountSnapshot;
    readonly instructionContext?: Partial<SharedInstructionInput> | undefined;
    readonly resumedContextSent?: boolean | undefined;
    readonly reportedModelCapabilities?: ReadonlyMap<string, ModelCapabilities> | undefined;
    readonly workflowExecutionProfile?:
      | ProviderSessionStartInput["workflowExecutionProfile"]
      | undefined;
    readonly readOnlyMode?: CodexReadOnlyMode | undefined;
  },
) {
  const turnInput: Array<
    | { type: "text"; text: string; text_elements: [] }
    | { type: "image"; url: string }
    | { type: "localImage"; path: string }
    | { type: "localAudio"; path: string }
  > = [];
  if (input.input) {
    turnInput.push({
      type: "text",
      text: input.input,
      text_elements: [],
    });
  }
  for (const attachment of input.attachments ?? []) {
    if (attachment.type === "localImage" || attachment.type === "localAudio") {
      turnInput.push(attachment);
    }
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

  const stagePolicy = state.workflowExecutionProfile
    ? codexReadOnlyStagePolicy(state.readOnlyMode)
    : undefined;
  const turnStartParams: {
    threadId: string;
    input: Array<
      | { type: "text"; text: string; text_elements: [] }
      | { type: "image"; url: string }
      | { type: "localImage"; path: string }
      | { type: "localAudio"; path: string }
    >;
    model?: string;
    serviceTier?: string | null;
    cyberAccessProgram?: "standard" | "daybreakBlue" | "daybreakRed";
    effort?: string;
    collaborationMode?: {
      mode: "default" | "plan";
      settings: {
        model: string;
        reasoning_effort: string | null;
        developer_instructions: string;
      };
    };
    additionalContext?: Record<string, CodexAdditionalContextEntry>;
    approvalPolicy?: "never" | "untrusted" | "on-request";
    approvalsReviewer?: "user";
    sandboxPolicy?:
      | typeof CODEX_READ_ONLY_TURN_SANDBOX_POLICY
      | typeof CODEX_POLICY_TURN_SANDBOX_POLICY;
  } = {
    threadId: state.providerThreadId,
    input: turnInput,
    // Every turn of a read-only workflow stage restates its policy, so a resumed or reused
    // thread can never run with whatever policy it was opened with.
    ...(stagePolicy
      ? {
          approvalPolicy: stagePolicy.approvalPolicy,
          approvalsReviewer: stagePolicy.approvalsReviewer,
          sandboxPolicy: stagePolicy.sandboxPolicy,
        }
      : {}),
  };
  const normalizedModel = resolveCodexModelForAccount(
    normalizeCodexModelSlug(input.model ?? state.model),
    state.account,
  );
  if (normalizedModel) {
    turnStartParams.model = normalizedModel;
  }
  // Persisted state and non-web callers can supply stale or invalid values;
  // resolve them to a model-supported effort at the provider boundary. Efforts
  // the session's `model/list` reported win over F5's built-in table, so a
  // CLI-only model receives the effort the composer offered for it.
  const effortModel = normalizedModel ?? DEFAULT_MODEL_BY_PROVIDER.codex;
  const reportedCapabilities = state.reportedModelCapabilities?.get(effortModel);
  const cyber = reportedCapabilities?.optionDescriptors?.find(
    (option) => option.id === "cyberAccessProgram",
  );
  if (cyber?.type === "select") {
    const program = [input.cyberAccessProgram, cyber.currentValue].find(
      (value): value is "standard" | "daybreakBlue" | "daybreakRed" =>
        (value === "standard" || value === "daybreakBlue" || value === "daybreakRed") &&
        cyber.options.some((option) => option.id === value),
    );
    if (program) turnStartParams.cyberAccessProgram = program;
  }
  if (input.serviceTier !== undefined) {
    // A persisted fast-mode choice must not reach a model whose reported tiers
    // lack it (the composer hides the toggle); null clears a thread-level tier.
    turnStartParams.serviceTier =
      resolveCodexServiceTier(input.serviceTier, reportedCapabilities) ?? null;
  }
  // The web client sends an explicit effort, but other callers and persisted
  // state may omit it (meaning the model default), so the resolver always runs
  // instead of letting the collaboration mode fall back to a fixed effort. It is
  // the same resolver the pickers use, so what they show is what runs.
  const resolvedEffort = resolveCodexEffectiveReasoningEffort(
    effortModel,
    input.effort,
    reportedCapabilities,
  );
  if (resolvedEffort) {
    turnStartParams.effort = resolvedEffort;
  }
  const { collaborationMode, additionalContext } = buildCodexTurnInstructions({
    ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
    ...(resolvedEffort !== undefined ? { effort: resolvedEffort } : {}),
    ...(state.instructionContext !== undefined
      ? { instructionContext: state.instructionContext }
      : {}),
    includeResumedContext: !state.resumedContextSent,
  });
  if (!turnStartParams.model) {
    turnStartParams.model = collaborationMode.settings.model;
  }
  turnStartParams.collaborationMode = collaborationMode;
  turnStartParams.additionalContext = additionalContext;

  return turnStartParams;
}

export function buildCodexTurnSteerParams(
  threadId: string,
  input: ReturnType<typeof buildCodexTurnStartParams>["input"],
  expectedTurnId: string,
) {
  return { threadId, input, expectedTurnId };
}

export function buildCodexInitializeParams(cliVersion?: string | null) {
  return {
    clientInfo: {
      name: "t3code_desktop",
      title: "F5 Desktop",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
      ...(supportsCodexRelease6(cliVersion)
        ? {
            requiredHumanApproval: true,
            explicitGatewayOauth: true,
          }
        : {}),
      requestAttestation: false,
      // Legacy opt-in, still accepted by 0.160.1. Its replacement is declaring
      // `openai/form` in `capabilities.extensions`. Standard MCP `form`/`url`
      // requests already use the private elicitation path (Release 3), which
      // was verified end-to-end against codex-cli 0.160.1. The OpenAI form
      // extension stays off: no live `openai/form` request has been exercised,
      // and the supported minimum is not yet past 0.147.
      mcpServerOpenaiFormElicitation: false,
      // Current servers suppress this high-volume diagnostic. The adapter and
      // UI still accept starts from older servers and persisted worklogs.
      optOutNotificationMethods: ["hook/started"] as string[],
    },
  } as const;
}

/**
 * The collaboration mode carries only the mode prompt; the rest of F5's
 * contract travels as `additionalContext`, which Codex keeps even when the
 * model catalog replaces the client's `developer_instructions`.
 */
export function buildCodexTurnInstructions(input: {
  readonly interactionMode?: "default" | "plan";
  readonly model?: string;
  readonly effort?: string;
  readonly instructionContext?: Partial<SharedInstructionInput>;
  readonly includeResumedContext?: boolean;
}): {
  collaborationMode: {
    mode: "default" | "plan";
    settings: {
      model: string;
      reasoning_effort: string | null;
      developer_instructions: string;
    };
  };
  additionalContext: Record<string, CodexAdditionalContextEntry>;
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
    ...(context?.workflowExecutionProfile
      ? { workflowExecutionProfile: context.workflowExecutionProfile }
      : {}),
    ...(context?.runtimeMode ? { runtimeMode: context.runtimeMode } : {}),
    ...(context?.projectMemories ? { projectMemories: context.projectMemories } : {}),
    ...(context?.integrationInstructions
      ? { integrationInstructions: context.integrationInstructions }
      : {}),
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
    collaborationMode: {
      mode: effectiveMode,
      settings: {
        model,
        // Null when the model takes no effort; a fixed fallback here would
        // override the resolved model default.
        reasoning_effort: input.effort ?? null,
        developer_instructions: buildCodexModeInstructions(instructionInput),
      },
    },
    additionalContext: buildCodexAdditionalContext(instructionInput),
  };
}

export function buildCodexInstructionContext(
  input: CodexAppServerStartSessionInput,
  resolvedCwd: string,
): Partial<SharedInstructionInput> {
  return {
    ...(input.projectTitle ? { projectTitle: input.projectTitle } : {}),
    ...(input.threadTitle ? { threadTitle: input.threadTitle } : {}),
    ...(input.turnCount !== undefined ? { turnCount: input.turnCount } : {}),
    cwd: resolvedCwd,
    runtimeMode: input.runtimeMode,
    ...(input.workflowExecutionProfile
      ? { workflowExecutionProfile: input.workflowExecutionProfile }
      : {}),
    ...(input.projectMemories ? { projectMemories: input.projectMemories } : {}),
    ...(input.integrationInstructions?.length
      ? { integrationInstructions: input.integrationInstructions }
      : {}),
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

export interface CodexOneOffWorker {
  readonly key: string;
  readonly threadId: ThreadId;
  busy: boolean;
  prompts: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Everything that changes the app-server process itself. Per-prompt values
 * (cwd, model, runtime mode) go on the provider thread instead.
 *
 * The signed-in account is not part of the key: after `codex login` switches
 * accounts in the same home, an idle warm worker can serve background prompts
 * with the previous login until it retires (at most `CODEX_ONE_OFF_WORKER_IDLE_MS`
 * after its last prompt). Changing the instance's settings rebuilds the
 * adapter, which stops every worker.
 */
export function codexOneOffPoolKey(
  providerOptions: ProviderSessionStartInput["providerOptions"],
): string {
  const options = providerOptions?.codex;
  return JSON.stringify([
    resolveCodexCommand(options?.binaryPath),
    resolveCodexHome({ homePath: options?.homePath }) ?? "",
    options?.launchArgs ?? [],
    options?.modelProvider ?? "",
  ]);
}

export function toCodexUserInputAnswer(value: unknown): CodexUserInputAnswer {
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

export function toCodexUserInputAnswers(
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
  const message = (
    error instanceof CodexJsonRpcError
      ? error.rawMessage + " " + error.message
      : error instanceof Error
        ? error.message
        : String(error)
  ).toLowerCase();
  if (message.includes("already has an active writer")) return false;
  if (!message.includes("thread/resume")) {
    return false;
  }

  return RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS.some((snippet) => message.includes(snippet));
}

/** Codex refuses to resume a session the user archived until it is unarchived. */
export function isArchivedThreadResumeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bsession \S+ is archived\b|\bcodex unarchive\b/i.test(message);
}

export function brandIfNonEmpty<T extends string>(
  value: string | undefined,
  maker: (value: string) => T,
): T | undefined {
  const normalized = value?.trim();
  return normalized?.length ? maker(normalized) : undefined;
}

export function normalizeProviderThreadId(value: string | undefined): string | undefined {
  return brandIfNonEmpty(value, (normalized) => normalized);
}

export function readCodexProviderOptions(input: CodexAppServerStartSessionInput): {
  readonly modelProvider?: string;
  readonly binaryPath?: string;
  readonly homePath?: string;
  readonly launchArgs?: ReadonlyArray<string>;
} {
  const options = input.providerOptions?.codex;
  if (!options) {
    return {};
  }
  return {
    ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
    ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}),
    ...(options.homePath ? { homePath: options.homePath } : {}),
    ...(options.launchArgs ? { launchArgs: options.launchArgs } : {}),
  };
}

export const assertSupportedCodexCliVersion = probeCodexCliVersion;

export function readResumeCursorThreadId(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const rawThreadId = (resumeCursor as Record<string, unknown>).threadId;
  return typeof rawThreadId === "string" ? normalizeProviderThreadId(rawThreadId) : undefined;
}

export function readResumeThreadId(input: CodexAppServerStartSessionInput): string | undefined {
  return readResumeCursorThreadId(input.resumeCursor);
}

export function toTurnId(value: string | undefined): TurnId | undefined {
  return brandIfNonEmpty(value, TurnId.makeUnsafe);
}

export function toProviderItemId(value: string | undefined): ProviderItemId | undefined {
  return brandIfNonEmpty(value, ProviderItemId.makeUnsafe);
}
