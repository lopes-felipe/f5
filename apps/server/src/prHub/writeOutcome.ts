import { Cause, Exit, Schema } from "effect";
import type { GitHubApiResponse } from "../git/githubApi.ts";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";

/** Only positive evidence of non-acceptance permits another explicit send. */
export function classifyPrWrite(
  result: Exit.Exit<GitHubApiResponse, SourceControlProviderError>,
  rejectionFallback?: string,
) {
  if (Exit.isFailure(result)) {
    const error = Cause.squash(result.cause);
    return {
      safeToRetry:
        Schema.is(SourceControlProviderError)(error) && error.requestDispatched === false,
      rejected: false,
      message: Schema.is(SourceControlProviderError)(error)
        ? error.detail
        : "The response was lost. Check GitHub before retrying.",
    };
  }
  const response = result.value;
  const limited =
    response.status === 429 ||
    (response.status === 403 &&
      (response.rateLimit.remaining === 0 || response.rateLimit.retryAfterSeconds != null));
  const rejected = !limited && [400, 401, 403, 404, 410, 422].includes(response.status);
  const hostMessage =
    typeof response.body === "object" &&
    response.body !== null &&
    "message" in response.body &&
    typeof response.body.message === "string"
      ? response.body.message.trim()
      : "";
  return {
    safeToRetry: limited,
    rejected,
    message: limited
      ? `GitHub rate limited this request. Retry after ${response.rateLimit.retryAfterSeconds ?? 30} seconds; the saved preview is unchanged.`
      : hostMessage ||
        (rejected && rejectionFallback) ||
        `GitHub returned HTTP ${response.status}. Inspect repository permissions and the saved submission before continuing.`,
  };
}
