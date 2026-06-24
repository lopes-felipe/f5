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

import type { GitHubCliError } from "../../git/Errors.ts";

export interface PrHubServiceShape {
  readonly getSnapshot: Effect.Effect<PrHubSnapshot>;
  readonly refreshNow: (input: PrHubRefreshInput) => Effect.Effect<PrHubSnapshot>;
  readonly streamSnapshots: Stream.Stream<PrHubSnapshot>;
  readonly approve: (input: PrHubReviewInput) => Effect.Effect<PrHubSnapshot, GitHubCliError>;
  readonly requestChanges: (
    input: PrHubRequestChangesInput,
  ) => Effect.Effect<PrHubSnapshot, GitHubCliError>;
  readonly comment: (input: PrHubCommentInput) => Effect.Effect<PrHubSnapshot, GitHubCliError>;
  readonly merge: (input: PrHubMergeInput) => Effect.Effect<PrHubSnapshot, GitHubCliError>;
  readonly markReady: (input: PrHubMarkReadyInput) => Effect.Effect<PrHubSnapshot, GitHubCliError>;
  readonly reRequestReview: (
    input: PrHubReRequestInput,
  ) => Effect.Effect<PrHubSnapshot, GitHubCliError>;
  readonly snooze: (input: PrHubSnoozeInput) => Effect.Effect<PrHubSnapshot, GitHubCliError>;
  readonly unsnooze: (input: PrHubUnsnoozeInput) => Effect.Effect<PrHubSnapshot, GitHubCliError>;
  readonly ignore: (input: PrHubIgnoreInput) => Effect.Effect<PrHubSnapshot, GitHubCliError>;
  readonly markSeen: (input: PrHubMarkSeenInput) => Effect.Effect<PrHubSnapshot, GitHubCliError>;
  readonly markNotified: (
    input: PrHubMarkNotifiedInput,
  ) => Effect.Effect<PrHubSnapshot, GitHubCliError>;
  readonly listLocalCheckoutCandidates: (
    input: PrHubLocalCandidatesInput,
  ) => Effect.Effect<ReadonlyArray<PrHubLocalCheckoutCandidate>>;
  readonly clearData: () => Effect.Effect<PrHubSnapshot, GitHubCliError>;
}

export class PrHubService extends ServiceMap.Service<PrHubService, PrHubServiceShape>()(
  "t3/prHub/Services/PrHubService",
) {}
