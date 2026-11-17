import { Cause, Exit, Schema } from "effect";
import type { GitHubApiResponse } from "../git/githubApi.ts";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";

/** Only positive evidence of non-acceptance permits another explicit send. */
export function classifyPrWrite(result: Exit.Exit<GitHubApiResponse, SourceControlProviderError>) {
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
  return {
    safeToRetry: limited,
    rejected,
    message: limited
      ? `GitHub rate limited this request. Retry after ${response.rateLimit.retryAfterSeconds ?? 30} seconds; the saved preview is unchanged.`
      : `GitHub returned HTTP ${response.status}. Inspect repository permissions and the saved submission before continuing.`,
  };
}

/** Review diagnostics must not change write classification or other PR operations. */
export function classifyReviewWrite(
  result: Exit.Exit<GitHubApiResponse, SourceControlProviderError>,
  phase: "creation" | "submission",
) {
  const outcome = classifyPrWrite(result);
  if (!outcome.rejected || Exit.isFailure(result)) return outcome;
  const body = result.value.body;
  const root = typeof body === "object" && body !== null ? body : null;
  const errors = root && "errors" in root && Array.isArray(root.errors) ? root.errors : [];
  const details = errors.flatMap((error: unknown) => {
    const message =
      typeof error === "string"
        ? error
        : typeof error === "object" && error !== null && "message" in error
          ? error.message
          : null;
    return typeof message === "string" && message.trim() ? [message.trim()] : [];
  });
  const message =
    root && "message" in root && typeof root.message === "string" ? root.message.trim() : "";
  const reason =
    [...new Set(details)].join("; ") ||
    (/^(unprocessable entity|validation failed|bad request|unauthorized|forbidden|not found|gone)$/i.test(
      message,
    )
      ? ""
      : message);
  return {
    ...outcome,
    message:
      phase === "creation"
        ? reason || "The host refused the review. Your draft is still here to try again."
        : [
            reason || "The host refused the review.",
            "Check the saved submission state before retrying.",
          ].join(" "),
  };
}
