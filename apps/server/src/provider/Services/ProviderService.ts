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
  McpReloadResult,
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
  readonly sessions: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly result: McpReloadResult;
  }>;
}

/**
 * ProviderServiceShape - Service API for provider session and turn orchestration.
 */
export interface ProviderServiceShape {
  /**
   * Start a provider session.
   */
  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;

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
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Read static capabilities for a provider adapter.
   */
  readonly getCapabilities: (
    provider: ProviderKind,
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
  readonly reloadMcpConfigForProject: (input: {
    readonly provider: ProviderKind;
    readonly projectId: ProjectId;
    readonly providerOptions?: ProviderSessionStartInput["providerOptions"];
    /** Limit the reload to these threads. */
    readonly threadIds?: ReadonlyArray<ThreadId>;
    /** Skip the per-session backoff (callers with their own retry loop). */
    readonly retry?: boolean;
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
