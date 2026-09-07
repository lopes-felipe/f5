import { GitHubCliError } from "./Errors.ts";

export function normalizeGitHubCliError(
  operation: "execute" | "stdout" | "request",
  error: unknown,
): GitHubCliError {
  if (error instanceof Error) {
    if (error.message.includes("Command not found: gh")) {
      return new GitHubCliError({
        operation,
        detail: "GitHub CLI (`gh`) is required but not available on PATH.",
        kind: "binary_missing",
        cause: error,
      });
    }

    const lower = error.message.toLowerCase();
    if (
      lower.includes("authentication failed") ||
      lower.includes("not logged in") ||
      lower.includes("gh auth login") ||
      lower.includes("no oauth token")
    ) {
      return new GitHubCliError({
        operation,
        detail: "GitHub CLI is not authenticated. Run `gh auth login` and retry.",
        kind: "unauthenticated",
        cause: error,
      });
    }

    if (lower.includes("rate limit") || lower.includes("secondary rate")) {
      return new GitHubCliError({
        operation,
        detail: "GitHub API rate limit reached.",
        kind: "rate_limited",
        cause: error,
      });
    }

    const httpStatus = error.message.match(/\bHTTP\s+(\d{3})\b/i)?.[1];
    if (httpStatus) {
      const statusCode = Number(httpStatus);
      const kind =
        statusCode === 401
          ? "unauthenticated"
          : statusCode === 403
            ? "forbidden"
            : statusCode === 429
              ? "rate_limited"
              : statusCode >= 500
                ? "network"
                : "generic";
      return new GitHubCliError({
        operation,
        detail: `GitHub API returned HTTP ${httpStatus}.`,
        kind,
        cause: error,
      });
    }

    if (
      lower.includes("could not resolve host") ||
      lower.includes("network") ||
      lower.includes("connection refused") ||
      lower.includes("connection reset") ||
      lower.includes("tls")
    ) {
      return new GitHubCliError({
        operation,
        detail: "GitHub CLI could not reach GitHub.",
        kind: "network",
        cause: error,
      });
    }

    if (lower.includes("timed out") || lower.includes("timeout")) {
      return new GitHubCliError({
        operation,
        detail: "GitHub CLI command timed out.",
        kind: "timeout",
        cause: error,
      });
    }

    if (lower.includes("forbidden") || lower.includes("resource not accessible")) {
      return new GitHubCliError({
        operation,
        detail: "GitHub refused access to the requested resource.",
        kind: "forbidden",
        cause: error,
      });
    }

    if (
      lower.includes("could not resolve to a pullrequest") ||
      lower.includes("repository.pullrequest") ||
      lower.includes("no pull requests found for branch") ||
      lower.includes("pull request not found")
    ) {
      return new GitHubCliError({
        operation,
        detail: "Pull request not found. Check the PR number or URL and try again.",
        kind: "not_found",
        cause: error,
      });
    }

    return new GitHubCliError({
      operation,
      detail: "GitHub CLI command failed.",
      kind: "generic",
      cause: error,
    });
  }

  return new GitHubCliError({
    operation,
    detail: "GitHub CLI command failed.",
    kind: "generic",
    cause: error,
  });
}
