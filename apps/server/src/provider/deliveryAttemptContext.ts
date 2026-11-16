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
