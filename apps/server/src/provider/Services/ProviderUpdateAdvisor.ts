import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderAdvisoryEntry,
  ServerProviderVersionAdvisory,
  ServerRunProviderUpdateResult,
} from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

export class ProviderUpdateRunError extends Schema.TaggedErrorClass<ProviderUpdateRunError>()(
  "ProviderUpdateRunError",
  {
    message: Schema.String,
  },
) {}

export type ProviderUpdateRunResult = Omit<ServerRunProviderUpdateResult, "providers">;

export interface ProviderUpdateAdvisorShape {
  readonly getAdvisoryFor: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly currentVersion: string | null;
  }) => Effect.Effect<ServerProviderVersionAdvisory>;
  readonly streamChanges: Stream.Stream<ReadonlyArray<ServerProviderAdvisoryEntry>>;
  readonly noteRegistryChanged: Effect.Effect<void>;
  readonly refreshAdvisories: (opts?: {
    readonly force?: boolean;
    readonly mode?: "scheduled" | "explicit";
    readonly instanceId?: ProviderInstanceId | undefined;
  }) => Effect.Effect<void>;
  readonly runUpdate: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderUpdateRunResult, ProviderUpdateRunError>;
}

export class ProviderUpdateAdvisor extends ServiceMap.Service<
  ProviderUpdateAdvisor,
  ProviderUpdateAdvisorShape
>()("t3/provider/Services/ProviderUpdateAdvisor") {}
