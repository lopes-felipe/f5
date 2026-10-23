/**
 * ProviderService - Service interface for provider sessions, turns, and checkpoints.
 *
 * Acts as the cross-provider facade used by transports (WebSocket/RPC). It
 * resolves provider adapters through `ProviderAdapterRegistry`, routes
 * session-scoped calls via `ProviderSessionDirectory`, and exposes one unified
 * provider event stream to callers.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and returns typed
 * domain errors for validation, session, codex, and checkpoint workflows.
 *
 * @module ProviderService
 */
import type {
  ElicitationSubmitInput,
  McpSessionReloadOutcome,
  ProviderInstanceId,
  ProjectId,
  ProviderInterruptTurnInput,
  ProviderKind,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionAction,
  ProviderSessionCapabilities,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ThreadId,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type { ProviderServiceError } from "../Errors.ts";
import type {
  ProviderAdapterCapabilities,
  ProviderConversationCompactionInput,
  ProviderConversationCompactionResult,
  ProviderOneOffPromptInput,
  ProviderOneOffPromptResult,
  ProviderThreadSnapshot,
} from "./ProviderAdapter.ts";

export interface ProviderMcpReloadOutcome {
  /** Sessions the reload reached, with their final result after retries. */
  readonly sessions: ReadonlyArray<McpSessionReloadOutcome>;
}

/**
 * ProviderServiceShape - Service API for provider session and turn orchestration.
 */
export interface ProviderSubmissionHandle {
  readonly acceptance: Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;
  readonly completion: Effect.Effect<void, ProviderServiceError>;
}

export interface ProviderServiceShape {
  readonly mcpApps?: import("./ProviderAdapter.ts").ProviderMcpApps<ProviderServiceError>;
  /** Preserve a send fence when ingestion cannot retain an admitted event. */
  readonly requireHistoryReconciliation?: (
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<void, ProviderServiceError>;
  /** Published before adapter startup, until its durable binding has been written. */
  readonly getStartingSessionIdentity?: (
    threadId: ThreadId,
  ) => { readonly instanceId: ProviderInstanceId; readonly generation: number } | undefined;
  readonly acknowledgeHistoryReconciliation?: (input: {
    readonly threadId: ThreadId;
    readonly markerId: string;
    readonly historyIdentity: string;
    readonly instanceId: import("@t3tools/contracts").ProviderInstanceId;
    readonly generation: number;
  }) => Effect.Effect<boolean, ProviderServiceError>;
  /** Registers a service-owned operation; caller cancellation cannot abandon transport. */
  readonly submitTurn?: (input: ProviderSendTurnInput) => Effect.Effect<ProviderSubmissionHandle>;

  readonly nativeOperations?: {
    readonly historyRecovery?: (
      input: import("@t3tools/contracts").NativeHistoryRecoveryInput,
    ) => Effect.Effect<
      import("@t3tools/contracts").NativeHistoryRecovery | null,
      ProviderServiceError
    >;
    readonly resolve?: (
      input: import("@t3tools/contracts").NativeOperationResolutionInput,
    ) => Effect.Effect<import("@t3tools/contracts").NativeOperationRecord, ProviderServiceError>;
    readonly execute: (
      input: import("@t3tools/contracts").NativeOperationInput,
    ) => Effect.Effect<import("@t3tools/contracts").NativeOperationRecord, ProviderServiceError>;
    readonly executeWithApply?: (
      input: import("@t3tools/contracts").NativeOperationInput,
      apply: (result: unknown) => Effect.Effect<void, ProviderServiceError>,
      prepare?: Effect.Effect<void, ProviderServiceError>,
      options?: { readonly background?: boolean },
    ) => Effect.Effect<import("@t3tools/contracts").NativeOperationRecord, ProviderServiceError>;
    readonly list: (
      threadId: ThreadId,
    ) => Effect.Effect<
      readonly import("@t3tools/contracts").NativeOperationRecord[],
      ProviderServiceError
    >;
    readonly inspect: (
      input: import("@t3tools/contracts").NativeOperationInspectInput,
    ) => Effect.Effect<unknown, ProviderServiceError>;
  };
  readonly renameThread?: (
    threadId: ThreadId,
    title: string,
  ) => Effect.Effect<void, ProviderServiceError>;
  /**
   * Start a provider session.
   */
  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;

  /** Replace only the generation inspected by the caller, under one service gate. */
  readonly replaceSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
    expected: { readonly instanceId: ProviderInstanceId; readonly generation: number },
  ) => Effect.Effect<ProviderSession | null, ProviderServiceError>;

  /**
   * Send a provider turn.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  /**
   * Interrupt a running provider turn.
   */
  readonly interruptTurn: (
    input: ProviderInterruptTurnInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider approval request.
   */
  readonly respondToRequest: (
    input: ProviderRespondToRequestInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider structured user-input request.
   */
  readonly respondToUserInput: (
    input: ProviderRespondToUserInputInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Deliver one private elicitation answer to the live session that owns the
   * request. Never recovers a session: an answer for an older generation is
   * refused. Values are neither logged nor recorded.
   */
  readonly respondToElicitation: (
    input: ElicitationSubmitInput,
  ) => Effect.Effect<"submitted", ProviderServiceError>;

  /**
   * Stop a provider session.
   */
  readonly stopSession: (
    input: ProviderStopSessionInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * List active provider sessions.
   *
   * Aggregates runtime session lists from all registered adapters.
   */
  /** In-flight starts are workspace claims, never reusable provider sessions. */
  readonly listStartingWorkspaces: () => Effect.Effect<
    ReadonlyArray<Pick<ProviderSession, "threadId" | "cwd">>
  >;
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Read static capabilities from the exact instance when supplied. The legacy
   * kind-only form resolves the default instance.
   */
  readonly getCapabilities: (
    provider: ProviderKind,
    instanceId?: ProviderInstanceId,
  ) => Effect.Effect<ProviderAdapterCapabilities, ProviderServiceError>;

  /**
   * Capabilities of the session generation a thread is bound to, routed
   * through the persisted binding (never starts or recovers a session).
   * `null` when the thread has no provider binding.
   */
  readonly getSessionCapabilities: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderSessionCapabilities | null, ProviderServiceError>;

  /**
   * Re-check generation, executable support and policy for one action.
   * Fails with `ProviderSessionActionUnavailableError` when refused.
   */
  readonly assertSessionAction: (input: {
    readonly threadId: ThreadId;
    readonly action: ProviderSessionAction;
    readonly expectedGeneration?: number;
  }) => Effect.Effect<ProviderSessionCapabilities, ProviderServiceError>;

  /**
   * Read a provider thread snapshot.
   */
  readonly readThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderThreadSnapshot, ProviderServiceError>;

  /**
   * Roll back provider conversation state by a number of turns.
   */
  readonly rollbackConversation: (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
    /** Provider turn id of the first dropped turn; see ProviderAdapterShape.rollbackThread. */
    readonly beforeTurnId?: string;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Run a provider-specific one-off prompt.
   */
  readonly runOneOffPrompt: (
    input: ProviderOneOffPromptInput,
  ) => Effect.Effect<ProviderOneOffPromptResult, ProviderServiceError>;

  /**
   * Run a provider-specific one-off conversation compaction request.
   */
  readonly compactConversation: (
    input: ProviderConversationCompactionInput,
  ) => Effect.Effect<ProviderConversationCompactionResult, ProviderServiceError>;

  /**
   * Reconcile live sessions of one provider in a project with the stored MCP
   * config. Each session is retried with bounded backoff. Its
   * `mcpEffectiveConfigVersion` advances once the reload reached it, unless
   * the result requires a restart; a stale version restarts the session at
   * its next turn. Per-session failures are reported in the result (and as
   * runtime warnings), not raised.
   */
  readonly readMcpSessionStatuses?: (
    input: import("@t3tools/contracts").McpGetServerStatusesRequest & {
      readonly desiredVersion: string;
    },
  ) => Effect.Effect<
    {
      readonly sessions: ReadonlyArray<import("@t3tools/contracts").McpSessionSummary>;
      readonly selected?: import("@t3tools/contracts").McpSessionSummary;
      readonly observation?: import("../mcpObservation.ts").McpAdapterObservation;
    },
    ProviderServiceError
  >;
  readonly getMcpReconnectTargets?: (
    input: import("@t3tools/contracts").McpReconnectServerRequest & {
      readonly provider: ProviderKind;
    },
  ) => Effect.Effect<
    {
      threadIds: ReadonlyArray<ThreadId>;
      failures: ReadonlyArray<{ threadId: ThreadId; message: string }>;
    },
    ProviderServiceError
  >;
  readonly reconnectMcpServerForProject?: (
    input: import("@t3tools/contracts").McpReconnectServerRequest & {
      readonly provider: ProviderKind;
      /** Server-internal: also reconnect provider-configured (external) servers by exact name. */
      readonly allowExternal?: boolean;
      /** Server-internal: skip these conversations (for example the one that just signed in). */
      readonly excludeThreadIds?: ReadonlyArray<ThreadId>;
    },
  ) => Effect.Effect<import("@t3tools/contracts").McpReconnectServerResult, ProviderServiceError>;
  /** The conversation's live session summary without provider I/O; `undefined` once it ends. */
  readonly getLiveMcpSession?: (input: {
    readonly provider: ProviderKind;
    readonly projectId: ProjectId;
    readonly instanceId?: ProviderInstanceId;
    readonly threadId: ThreadId;
  }) => Effect.Effect<
    import("@t3tools/contracts").McpSessionSummary | undefined,
    ProviderServiceError
  >;
  /**
   * Starts a user-initiated MCP sign-in through one running session: the requested
   * conversation, or the session `readMcpSessionStatuses` would select.
   */
  readonly authenticateMcpServerForProject?: (input: {
    readonly provider: ProviderKind;
    readonly projectId: ProjectId;
    readonly instanceId?: ProviderInstanceId;
    readonly serverName: string;
    readonly threadId?: ThreadId;
    readonly desiredVersion?: string;
  }) => Effect.Effect<
    {
      readonly threadId: ThreadId;
      readonly instanceId: ProviderInstanceId;
      readonly generation: number;
      readonly authUrl?: string;
      readonly callbackExpected: boolean;
      readonly ownership: "managed" | "external";
    },
    ProviderServiceError
  >;

  readonly reloadMcpConfigForProject: (input: {
    readonly provider: ProviderKind;
    readonly instanceId?: ProviderInstanceId;
    readonly requestedVersion?: string;
    readonly projectId: ProjectId;
    readonly providerOptions?: ProviderSessionStartInput["providerOptions"];
    /** Limit the reload to these threads. */
    readonly threadIds?: ReadonlyArray<ThreadId>;
    /** Skip the per-session backoff for one-shot internal callers. */
    readonly retry?: boolean;
    /** Internal caller-specific backoff; all attempts keep the gated snapshot. */
    readonly retryDelaysMs?: ReadonlyArray<number>;
    /**
     * Post per-session runtime warnings for failures a later attempt might fix
     * (default true). Restart-required results are final and always warn.
     */
    readonly warn?: boolean;
  }) => Effect.Effect<ProviderMcpReloadOutcome, ProviderServiceError>;

  /**
   * Canonical provider runtime event stream.
   *
   * Fan-out is owned by ProviderService (not by a standalone event-bus service).
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}

/**
 * ProviderService - Service tag for provider orchestration.
 */
export class ProviderService extends ServiceMap.Service<ProviderService, ProviderServiceShape>()(
  "t3/provider/Services/ProviderService",
) {}
