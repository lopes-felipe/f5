import {
  isKnownProviderKind,
  type ModelSelection,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import { runtimeModeCapabilities } from "@t3tools/shared/runtimeMode";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { AgentBridgeHostShape } from "../agentBridge/AgentBridgeHost.ts";
import { isProviderUsable } from "../agentBridge/threadTools.ts";

export type BoundThreadIneligibility =
  | "missing"
  | "archived"
  | "foreign_project"
  | "scheduled_origin"
  | "no_model_selection"
  | "unsupervised"
  | "provider_unavailable";
export interface BoundExecution {
  readonly thread: OrchestrationThread;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly provider: ServerProvider;
}
export type BoundExecutionResult =
  | ({ readonly kind: "eligible" } & BoundExecution)
  | { readonly kind: "ineligible"; readonly reason: BoundThreadIneligibility };

export const boundThreadIneligibilityMessage: Record<BoundThreadIneligibility, string> = {
  missing: "The conversation no longer exists.",
  archived: "The conversation is archived.",
  foreign_project: "The conversation belongs to another project.",
  scheduled_origin: "Conversations created by another scheduled task cannot receive bound runs.",
  no_model_selection: "Send a message in this conversation before scheduling into it.",
  unsupervised: "Agent schedules require a conversation in approval-required mode.",
  provider_unavailable: "The conversation's provider or model is unavailable.",
};

/** The only place a bound run's effective settings are computed: the live thread wins over the task. */
export const resolveBoundExecution = (input: {
  readonly snapshot: OrchestrationReadModel;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly projectId: string;
  readonly threadId: string;
  /** Agent-authored tasks may only drive supervised conversations. */
  readonly requireSupervised: boolean;
  /** The thread already belongs to a run of an unbound task. */
  readonly ownedByUnboundRun: boolean;
}): BoundExecutionResult => {
  const ineligible = (reason: BoundThreadIneligibility) =>
    ({ kind: "ineligible", reason }) as const;
  const thread = input.snapshot.threads.find((t) => t.id === input.threadId);
  if (!thread || thread.deletedAt !== null) return ineligible("missing");
  if (thread.archivedAt !== null) return ineligible("archived");
  if (thread.projectId !== input.projectId) return ineligible("foreign_project");
  if (thread.scheduledOrigin || input.ownedByUnboundRun) return ineligible("scheduled_origin");
  const modelSelection = thread.modelSelection;
  if (!modelSelection) return ineligible("no_model_selection");
  if (input.requireSupervised && thread.runtimeMode !== "approval-required")
    return ineligible("unsupervised");
  const provider = input.providers.find((p) => p.instanceId === modelSelection.instanceId);
  if (
    !provider ||
    !isProviderUsable(provider) ||
    !isKnownProviderKind(provider.driver) ||
    !runtimeModeCapabilities(provider.driver).has(thread.runtimeMode) ||
    (provider.models.length > 0 && !provider.models.some((m) => m.slug === modelSelection.model))
  )
    return ineligible("provider_unavailable");
  return {
    kind: "eligible",
    thread,
    modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    provider,
  };
};

/** True when the conversation has no running turn, queued work, pending attention or in-flight send. */
export const isBoundThreadIdle = (
  sql: SqlClient.SqlClient,
  host: Pick<AgentBridgeHostShape, "getQueueSnapshot">,
  thread: OrchestrationThread,
) =>
  Effect.gen(function* () {
    if (thread.session?.activeTurnId || thread.latestTurn?.state === "running") return false;
    if ((yield* host.getQueueSnapshot(thread.id)).items.length > 0) return false;
    const busy =
      yield* sql`SELECT 1 FROM projection_pending_approvals WHERE thread_id=${thread.id} AND status='pending'
      UNION ALL SELECT 1 FROM projection_pending_user_inputs WHERE thread_id=${thread.id} AND resolution IS NULL
      UNION ALL SELECT 1 FROM provider_turn_deliveries WHERE thread_id=${thread.id} AND state='sending'
      LIMIT 1`;
    return busy.length === 0;
  });
