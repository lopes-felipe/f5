import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderAdvisoryEntry,
  ServerProviderVersionAdvisory,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

export interface ProviderUpdateAdvisorShape {
  readonly getAdvisoryFor: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly currentVersion: string | null;
  }) => Effect.Effect<ServerProviderVersionAdvisory>;
  readonly streamChanges: Stream.Stream<ReadonlyArray<ServerProviderAdvisoryEntry>>;
  readonly noteRegistryChanged: Effect.Effect<void>;
  readonly refreshAdvisories: (opts?: { readonly force?: boolean }) => Effect.Effect<void>;
}

export class ProviderUpdateAdvisor extends ServiceMap.Service<
  ProviderUpdateAdvisor,
  ProviderUpdateAdvisorShape
>()("t3/provider/Services/ProviderUpdateAdvisor") {}
