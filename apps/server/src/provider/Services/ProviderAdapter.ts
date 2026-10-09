/**
 * ProviderAdapter - Provider-specific runtime adapter contract.
 *
 * Defines the provider-native session/protocol operations that `ProviderService`
 * routes to after resolving the target provider. Implementations should focus
 * on provider behavior only and avoid cross-provider orchestration concerns.
 *
 * @module ProviderAdapter
 */
import type {
  ModelSelection,
  ApprovalRequestId,
  ChatAttachment,
  ElicitationAction,
  ElicitationContent,
  ProviderApprovalDecision,
  ProviderKind,
  ProviderStartOptions,
  ProviderUserInputAnswers,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ThreadId,
  ProviderTurnStartResult,
  TurnId,
} from "@t3tools/contracts";
import type { Effect } from "effect";
import type { Stream } from "effect";

export type ProviderSessionModelSwitchMode = "in-session" | "restart-session" | "unsupported";

export interface ProviderAdapterCapabilities {
  /**
   * Declares whether changing the model on an existing session is supported.
   */
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
  readonly nativeTurnIdempotency?: boolean;
  readonly runtimeCapabilities?: import("@t3tools/contracts").ProviderRuntimeCapabilities;
}

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
}

export interface ProviderRollbackOptions {
  readonly beforeTurnId?: string;
  /** Persist a changed native cursor before history hydration can fail. */
  readonly onAdoptSession?: (session: ProviderSession) => Promise<void>;
}

export interface ProviderOneOffPromptInput {
  readonly threadId: ThreadId;
  /** Required when modelSelection is absent. */
  readonly provider?: ProviderKind;
  readonly prompt: string;
  readonly cwd?: string;
  readonly model?: string;
  /** Explicit instance/model/options; overrides legacy routing and skips source-thread configuration. */
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: ProviderSessionStartInput["runtimeMode"];
  readonly providerOptions?: ProviderStartOptions;
  readonly timeoutMs?: number;
}

export interface ProviderOneOffPromptResult {
  readonly text: string;
}

export interface ProviderConversationCompactionInput extends ProviderOneOffPromptInput {
  readonly provider: ProviderKind;
}

export interface ProviderConversationCompactionResult {
  readonly summary: string;
}

export type ProviderResolvedAttachment = ChatAttachment & {
  /**
   * Server-authorized local copy. This field is provider-only and must never
   * be persisted into orchestration messages or returned over the wire.
   */
  readonly localPath: string;
};

export type ProviderAdapterSendTurnInput = ProviderSendTurnInput & {
  /** Populated by ProviderService; optional for direct adapter harnesses. */
  readonly resolvedAttachments?: ReadonlyArray<ProviderResolvedAttachment>;
};

export interface ProviderAdapterShape<TError> {
  /**
   * Provider kind implemented by this adapter.
   */
  readonly provider: ProviderKind;
  readonly capabilities: ProviderAdapterCapabilities;

  /**
   * Start a provider-backed session.
   */
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, TError>;

  /**
   * Send a turn to an active provider session.
   */
  readonly steerTurn?: (
    input: ProviderAdapterSendTurnInput & { readonly expectedTurnId: TurnId },
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  readonly sendTurn: (
    input: ProviderAdapterSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /**
   * Interrupt an active turn.
   */
  readonly interruptTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void, TError>;

  /**
   * Respond to an interactive approval request.
   */
  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TError>;

  /**
   * Respond to a structured user-input request.
   */
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TError>;

  /**
   * Deliver one private elicitation answer. Values are validated against the
   * request's descriptor, handed to the native transport and never logged,
   * emitted or persisted. Resolves when the transport accepted the answer.
   */
  readonly respondToElicitation?: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    response: { readonly action: ElicitationAction; readonly content?: ElicitationContent },
  ) => Effect.Effect<"submitted", TError>;

  /**
   * Stop one provider session.
   */
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * List currently active provider sessions for this adapter.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Check whether this adapter owns an active session id.
   */
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

  /**
   * Read a provider thread snapshot.
   */
  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Roll back a provider thread by N turns.
   *
   * `beforeTurnId` names the provider turn that is dropped together with every
   * later turn. Providers with an absolute revert API (Codex `thread/revert`)
   * use it so a retried request cannot remove extra turns; others ignore it.
   */
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
    options?: ProviderRollbackOptions,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Run a provider-specific one-off prompt outside the active session stream.
   */
  readonly runOneOffPrompt?: (
    input: ProviderOneOffPromptInput,
  ) => Effect.Effect<ProviderOneOffPromptResult, TError>;

  /**
   * Run a provider-specific one-off conversation compaction request.
   */
  readonly compactConversation?: (
    input: ProviderConversationCompactionInput,
  ) => Effect.Effect<ProviderConversationCompactionResult, TError>;

  /**
   * Native discovery state of one live session (initialization finished,
   * command catalog loaded). Adapters without discovery omit this.
   */
  readonly getSessionDiscovery?: (
    threadId: ThreadId,
  ) => Effect.Effect<import("../sessionCapabilities.ts").ProviderSessionDiscovery | undefined>;

  /**
   * Reconcile one live session with the desired F5-owned MCP servers and
   * report the observed result. Servers the provider loads from its own
   * settings or plugins are never removed by omission.
   */
  readonly reloadMcpConfig?: (input: {
    readonly threadId: ThreadId;
    readonly mcpServers: ProviderStartOptions["mcpServers"] | undefined;
  }) => Effect.Effect<import("@t3tools/contracts").McpReloadResult, TError>;

  /**
   * Stop all sessions owned by this adapter.
   */
  readonly stopAll: () => Effect.Effect<void, TError>;

  /**
   * Canonical runtime event stream emitted by this adapter.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
