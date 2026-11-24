import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type { ProviderThreadSnapshot } from "./Services/ProviderAdapter";
import type { ProviderTurnStartResult } from "@t3tools/contracts";
import type { ProviderServiceError } from "./Errors";

/** Internal outbox hook, inherited by the service-owned submission fiber. */
export const DeliveryAttemptContext = ServiceMap.Reference<{
  readonly attemptId: string;
  readonly accepted: (
    receipt: ProviderTurnStartResult,
    identity: { readonly runtimeGeneration: number; readonly nativeHistoryIdentity: string | null },
  ) => Effect.Effect<void, ProviderServiceError>;
  readonly prepared: (
    snapshot: ProviderThreadSnapshot | null,
  ) => Effect.Effect<void, ProviderServiceError>;
} | null>("f5/provider/DeliveryAttemptContext", { defaultValue: () => null });

/**
 * Lets an adapter whose `sendTurn` lasts the whole turn (ACP `session/prompt`) report the
 * delivery accepted once the agent shows it is working on the prompt, instead of when the
 * turn ends. Calls after the first are ignored, and a failure is logged rather than raised:
 * acceptance after `sendTurn` returns remains the fallback. `null` outside a delivery.
 */
export const TurnAcceptanceSignal = ServiceMap.Reference<{
  readonly accept: (receipt: ProviderTurnStartResult) => Effect.Effect<void>;
} | null>("f5/provider/TurnAcceptanceSignal", { defaultValue: () => null });
