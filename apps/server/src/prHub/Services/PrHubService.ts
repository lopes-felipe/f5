import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";
import type {
  PrHubCommentInput,
  PrHubIgnoreInput,
  PrHubLocalCandidatesInput,
  PrHubLocalCheckoutCandidate,
  PrHubMarkNotifiedInput,
  PrHubMarkReadyInput,
  PrHubMarkSeenInput,
  PrHubMergeInput,
  PrHubRefreshInput,
  PrHubRequestChangesInput,
  PrHubReRequestInput,
  PrHubReviewInput,
  PrHubSnapshot,
  PrHubSnoozeInput,
  PrHubUnsnoozeInput,
} from "@t3tools/contracts";

import type { SourceControlProviderError } from "../../sourceControl/SourceControlProvider.ts";

export interface PrHubServiceShape {
  readonly getSnapshot: Effect.Effect<PrHubSnapshot>;
  readonly refreshNow: (input: PrHubRefreshInput) => Effect.Effect<PrHubSnapshot>;
  readonly streamSnapshots: Stream.Stream<PrHubSnapshot>;
  readonly approve: (
    input: PrHubReviewInput,
  ) => Effect.Effect<PrHubSnapshot, SourceControlProviderError>;
  readonly requestChanges: (
    input: PrHubRequestChangesInput,
  ) => Effect.Effect<PrHubSnapshot, SourceControlProviderError>;
  readonly comment: (
    input: PrHubCommentInput,
  ) => Effect.Effect<PrHubSnapshot, SourceControlProviderError>;
  readonly merge: (
    input: PrHubMergeInput,
  ) => Effect.Effect<PrHubSnapshot, SourceControlProviderError>;
  readonly markReady: (
    input: PrHubMarkReadyInput,
  ) => Effect.Effect<PrHubSnapshot, SourceControlProviderError>;
  readonly reRequestReview: (
    input: PrHubReRequestInput,
  ) => Effect.Effect<PrHubSnapshot, SourceControlProviderError>;
  readonly snooze: (
    input: PrHubSnoozeInput,
  ) => Effect.Effect<PrHubSnapshot, SourceControlProviderError>;
  readonly unsnooze: (
    input: PrHubUnsnoozeInput,
  ) => Effect.Effect<PrHubSnapshot, SourceControlProviderError>;
  readonly ignore: (
    input: PrHubIgnoreInput,
  ) => Effect.Effect<PrHubSnapshot, SourceControlProviderError>;
  readonly markSeen: (
    input: PrHubMarkSeenInput,
  ) => Effect.Effect<PrHubSnapshot, SourceControlProviderError>;
  readonly markNotified: (
    input: PrHubMarkNotifiedInput,
  ) => Effect.Effect<PrHubSnapshot, SourceControlProviderError>;
  readonly listLocalCheckoutCandidates: (
    input: PrHubLocalCandidatesInput,
  ) => Effect.Effect<ReadonlyArray<PrHubLocalCheckoutCandidate>>;
  readonly clearData: () => Effect.Effect<PrHubSnapshot, SourceControlProviderError>;
}

export class PrHubService extends ServiceMap.Service<PrHubService, PrHubServiceShape>()(
  "t3/prHub/Services/PrHubService",
) {}
