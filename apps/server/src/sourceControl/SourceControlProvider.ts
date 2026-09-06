import {
  SourceControlProviderKind,
  SourceControlRateLimit,
  SourceControlPullRequestAction,
  type SourceControlCapability,
  type SourceControlProviderIdentity,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";

import type { ProcessRunResult } from "../processRunner.ts";

export const SourceControlProviderErrorKind = Schema.Literals([
  "provider_missing",
  "unauthenticated",
  "rate_limited",
  "network",
  "timeout",
  "forbidden",
  "not_found",
  "invalid_response",
  "unsupported",
  "generic",
]);
export type SourceControlProviderErrorKind = typeof SourceControlProviderErrorKind.Type;

export class SourceControlProviderError extends Schema.TaggedErrorClass<SourceControlProviderError>()(
  "SourceControlProviderError",
  {
    provider: SourceControlProviderKind,
    rateLimit: Schema.optional(SourceControlRateLimit),
    operation: Schema.String,
    detail: Schema.String,
    kind: SourceControlProviderErrorKind,
    host: Schema.optional(Schema.String),
    action: Schema.optional(SourceControlPullRequestAction),
    retryAfterSeconds: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `${this.provider} source-control provider failed in ${this.operation}: ${this.detail}`;
  }
}

export interface SourceControlPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headRefOid?: string | null;
  readonly state?: "open" | "closed" | "merged";
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
}

export interface SourceControlRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export interface SourceControlMergePullRequestInput {
  readonly cwd: string;
  readonly url: string;
  readonly method: "squash" | "merge" | "rebase";
  readonly expectedHeadOid?: string | undefined;
}

/**
 * Provider-neutral seam for the source-control operations used by Git workflows
 * and PR Hub. Provider adapters own CLI/API quirks and translate all failures to
 * SourceControlProviderError before they cross this boundary.
 */
export interface SourceControlProvider {
  readonly kind: SourceControlProviderKind;
  readonly capabilities: ReadonlyArray<SourceControlCapability>;
  readonly capability: (action: SourceControlPullRequestAction) => SourceControlCapability;
  readonly requireCapability: (
    action: SourceControlPullRequestAction,
  ) => Effect.Effect<void, SourceControlProviderError>;
  readonly execute: (input: {
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly timeoutMs?: number;
  }) => Effect.Effect<ProcessRunResult, SourceControlProviderError>;
  readonly listOpenPullRequests: (input: {
    readonly cwd: string;
    readonly headSelector: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<SourceControlPullRequestSummary>, SourceControlProviderError>;
  readonly getPullRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<SourceControlPullRequestSummary, SourceControlProviderError>;
  readonly getRepositoryCloneUrls: (input: {
    readonly cwd: string;
    readonly repository: string;
  }) => Effect.Effect<SourceControlRepositoryCloneUrls, SourceControlProviderError>;
  readonly createPullRequest: (input: {
    readonly cwd: string;
    readonly baseBranch: string;
    readonly headSelector: string;
    readonly title: string;
    readonly bodyFile: string;
  }) => Effect.Effect<void, SourceControlProviderError>;
  readonly getDefaultBranch: (input: {
    readonly cwd: string;
  }) => Effect.Effect<string | null, SourceControlProviderError>;
  readonly checkoutPullRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly force?: boolean;
  }) => Effect.Effect<void, SourceControlProviderError>;
  readonly getAuthenticatedLogin: (input: {
    readonly cwd: string;
  }) => Effect.Effect<string, SourceControlProviderError>;
  readonly getViewerTeams: (input: {
    readonly cwd: string;
  }) => Effect.Effect<ReadonlyArray<string>, SourceControlProviderError>;
  readonly query: (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly document: string;
    readonly variables?: Readonly<
      Record<
        string,
        | string
        | number
        | boolean
        | null
        | undefined
        | ReadonlyArray<string | number | boolean | null | undefined>
      >
    >;
  }) => Effect.Effect<unknown, SourceControlProviderError>;
  readonly searchPullRequests: (input: {
    readonly cwd: string;
    readonly qualifiers: ReadonlyArray<string>;
    readonly limit?: number;
  }) => Effect.Effect<unknown, SourceControlProviderError>;
  readonly approvePullRequest: (input: {
    readonly cwd: string;
    readonly url: string;
    readonly body?: string | undefined;
  }) => Effect.Effect<void, SourceControlProviderError>;
  readonly requestChanges: (input: {
    readonly cwd: string;
    readonly url: string;
    readonly body: string;
  }) => Effect.Effect<void, SourceControlProviderError>;
  readonly commentPullRequest: (input: {
    readonly cwd: string;
    readonly url: string;
    readonly body: string;
  }) => Effect.Effect<void, SourceControlProviderError>;
  readonly mergePullRequest: (
    input: SourceControlMergePullRequestInput,
  ) => Effect.Effect<void, SourceControlProviderError>;
  readonly markPullRequestReady: (input: {
    readonly cwd: string;
    readonly url: string;
  }) => Effect.Effect<void, SourceControlProviderError>;
  readonly addPullRequestReviewers: (input: {
    readonly cwd: string;
    readonly url: string;
    readonly reviewers: ReadonlyArray<string>;
  }) => Effect.Effect<void, SourceControlProviderError>;
  readonly changePullRequestReviewers: (input: {
    readonly cwd: string;
    readonly url: string;
    readonly add: ReadonlyArray<string>;
    readonly remove: ReadonlyArray<string>;
  }) => Effect.Effect<void, SourceControlProviderError>;
  readonly updatePullRequestBranch: (input: {
    readonly cwd: string;
    readonly url: string;
    readonly method: "merge" | "rebase";
  }) => Effect.Effect<void, SourceControlProviderError>;
  readonly updatePullRequestComment: (input: {
    readonly cwd: string;
    readonly host: string;
    readonly repository: string;
    readonly commentId: string;
    readonly kind: "issue-comment" | "review-comment";
    readonly body: string;
  }) => Effect.Effect<void, SourceControlProviderError>;
}

export interface SourceControlProviderRegistry {
  readonly providers: ReadonlyArray<SourceControlProvider>;
  readonly get: (
    kind: SourceControlProviderKind,
  ) => Effect.Effect<SourceControlProvider, SourceControlProviderError>;
  readonly getForIdentity: (
    identity: SourceControlProviderIdentity,
  ) => Effect.Effect<SourceControlProvider, SourceControlProviderError>;
}

export function makeSourceControlProviderRegistry(
  providers: ReadonlyArray<SourceControlProvider>,
): SourceControlProviderRegistry {
  const byKind = new Map(providers.map((provider) => [provider.kind, provider] as const));
  const get = (kind: SourceControlProviderKind) => {
    const provider = byKind.get(kind);
    return provider
      ? Effect.succeed(provider)
      : Effect.fail(
          new SourceControlProviderError({
            provider: kind,
            operation: "registry.get",
            detail: `Source-control provider '${kind}' is not available.`,
            kind: "unsupported",
          }),
        );
  };
  return {
    providers: [...byKind.values()],
    get,
    getForIdentity: (identity) => get(identity.kind),
  };
}
