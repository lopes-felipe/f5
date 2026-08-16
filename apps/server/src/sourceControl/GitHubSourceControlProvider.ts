import {
  SOURCE_CONTROL_PULL_REQUEST_ACTIONS,
  type SourceControlCapability,
  type SourceControlPullRequestAction,
} from "@t3tools/contracts";
import { Effect } from "effect";

import type { GitHubCliError } from "../git/Errors.ts";
import type { GitHubCliShape } from "../git/Services/GitHubCli.ts";
import {
  SourceControlProviderError,
  type SourceControlProvider,
  type SourceControlProviderErrorKind,
} from "./SourceControlProvider.ts";

const SUPPORTED_ACTIONS = new Set<SourceControlPullRequestAction>([
  "approve",
  "request-changes",
  "comment",
  "merge",
  "mark-ready",
  "request-reviewers",
  "update-branch",
  "edit-comment",
  "react",
  "change-reviewers",
]);

export const GITHUB_SOURCE_CONTROL_CAPABILITIES: ReadonlyArray<SourceControlCapability> =
  SOURCE_CONTROL_PULL_REQUEST_ACTIONS.map((action) =>
    SUPPORTED_ACTIONS.has(action)
      ? { action, supported: true }
      : {
          action,
          supported: false,
          reason: "This GitHub action is not available in the current f5 integration.",
        },
  );

function mapErrorKind(kind: GitHubCliError["kind"]): SourceControlProviderErrorKind {
  switch (kind) {
    case "binary_missing":
      return "provider_missing";
    case "invalid_json":
      return "invalid_response";
    case "unauthenticated":
    case "rate_limited":
    case "network":
    case "timeout":
    case "forbidden":
    case "not_found":
    case "generic":
      return kind;
    case undefined:
      return "generic";
  }
}

export function mapGitHubCliError(error: GitHubCliError): SourceControlProviderError {
  return new SourceControlProviderError({
    provider: "github",
    operation: error.operation,
    detail: error.detail,
    kind: mapErrorKind(error.kind),
    ...(error.cause === undefined ? {} : { cause: error.cause }),
  });
}

export function makeGitHubSourceControlProvider(github: GitHubCliShape): SourceControlProvider {
  const mapGithubError = <A>(effect: Effect.Effect<A, GitHubCliError>) =>
    effect.pipe(Effect.mapError(mapGitHubCliError));
  const capability = (action: SourceControlPullRequestAction): SourceControlCapability =>
    GITHUB_SOURCE_CONTROL_CAPABILITIES.find((entry) => entry.action === action) ?? {
      action,
      supported: false,
      reason: "This GitHub action is not available in the current f5 integration.",
    };
  const requireCapability = (action: SourceControlPullRequestAction) => {
    const current = capability(action);
    return current.supported
      ? Effect.void
      : Effect.fail(
          new SourceControlProviderError({
            provider: "github",
            operation: "capability.require",
            detail: current.reason ?? `GitHub does not support '${action}' in f5.`,
            kind: "unsupported",
            action,
          }),
        );
  };

  return {
    kind: "github",
    capabilities: GITHUB_SOURCE_CONTROL_CAPABILITIES,
    capability,
    requireCapability,
    execute: (input) => mapGithubError(github.execute(input)),
    listOpenPullRequests: (input) => mapGithubError(github.listOpenPullRequests(input)),
    getPullRequest: (input) => mapGithubError(github.getPullRequest(input)),
    getRepositoryCloneUrls: (input) => mapGithubError(github.getRepositoryCloneUrls(input)),
    createPullRequest: (input) => mapGithubError(github.createPullRequest(input)),
    getDefaultBranch: (input) => mapGithubError(github.getDefaultBranch(input)),
    checkoutPullRequest: (input) => mapGithubError(github.checkoutPullRequest(input)),
    getAuthenticatedLogin: (input) => mapGithubError(github.getAuthenticatedLogin(input)),
    getViewerTeams: (input) => mapGithubError(github.getViewerTeams(input)),
    query: (input) =>
      mapGithubError(
        github.runGraphql({
          cwd: input.cwd,
          ...(input.host === undefined ? {} : { host: input.host }),
          query: input.document,
          ...(input.variables === undefined ? {} : { variables: input.variables }),
        }),
      ),
    searchPullRequests: (input) =>
      mapGithubError(
        github.searchPullRequests({
          cwd: input.cwd,
          args: input.qualifiers,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        }),
      ),
    approvePullRequest: (input) =>
      requireCapability("approve").pipe(
        Effect.andThen(mapGithubError(github.reviewPullRequest(input))),
      ),
    requestChanges: (input) =>
      requireCapability("request-changes").pipe(
        Effect.andThen(mapGithubError(github.requestChanges(input))),
      ),
    commentPullRequest: (input) =>
      requireCapability("comment").pipe(
        Effect.andThen(mapGithubError(github.commentPullRequest(input))),
      ),
    mergePullRequest: (input) =>
      requireCapability("merge").pipe(
        Effect.andThen(mapGithubError(github.mergePullRequest(input))),
      ),
    markPullRequestReady: (input) =>
      requireCapability("mark-ready").pipe(
        Effect.andThen(mapGithubError(github.markPullRequestReady(input))),
      ),
    addPullRequestReviewers: (input) =>
      requireCapability("request-reviewers").pipe(
        Effect.andThen(mapGithubError(github.addPullRequestReviewers(input))),
      ),
    changePullRequestReviewers: (input) =>
      requireCapability("change-reviewers").pipe(
        Effect.andThen(mapGithubError(github.changePullRequestReviewers(input))),
      ),
    updatePullRequestBranch: (input) =>
      requireCapability("update-branch").pipe(
        Effect.andThen(mapGithubError(github.updatePullRequestBranch(input))),
      ),
    updatePullRequestComment: (input) =>
      requireCapability("edit-comment").pipe(
        Effect.andThen(mapGithubError(github.updatePullRequestComment(input))),
      ),
  };
}
