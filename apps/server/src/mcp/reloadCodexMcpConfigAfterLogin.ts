import { type ProjectId, type ProviderStartOptions, type ThreadId } from "@t3tools/contracts";
import { Duration, Effect } from "effect";

import { ProviderValidationError, type ProviderServiceError } from "../provider/Errors.ts";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";

export const CODEX_MCP_LOGIN_RELOAD_RETRY_DELAYS_MS = [1_000, 3_000, 5_000] as const;

export const CODEX_MCP_LOGIN_RELOAD_FAILURE_MESSAGE =
  "Login completed, but reloading live Codex sessions failed. Apply the shared MCP config to live sessions to retry.";

export function reloadCodexMcpConfigAfterLogin(input: {
  readonly providerService: Pick<ProviderServiceShape, "reloadMcpConfigForProject">;
  readonly projectId: ProjectId;
  readonly serverName?: string;
  readonly providerOptions?: ProviderStartOptions;
  readonly retryDelaysMs?: ReadonlyArray<number>;
}) {
  const retryDelaysMs = input.retryDelaysMs ?? CODEX_MCP_LOGIN_RELOAD_RETRY_DELAYS_MS;
  // This loop owns the retries, so the service's per-session backoff is off.
  // Retryable failures warn only on the last attempt; restart-required
  // results are final and warn at once. Each retry reloads only the sessions
  // that still failed, so nothing warns twice.
  const reloadOnce = (attemptIndex: number, threadIds: ReadonlyArray<ThreadId> | undefined) =>
    input.providerService
      .reloadMcpConfigForProject({
        provider: "codex",
        projectId: input.projectId,
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
        ...(threadIds ? { threadIds } : {}),
        retry: false,
        warn: attemptIndex >= retryDelaysMs.length,
      })
      .pipe(
        Effect.map((outcome) =>
          outcome.sessions
            .filter((session) => !session.result.converged && !session.result.restartRequired)
            .map((session) => session.threadId),
        ),
      );

  const reloadWithRetry = (
    attemptIndex: number,
    threadIds: ReadonlyArray<ThreadId> | undefined,
  ): Effect.Effect<void, ProviderServiceError> =>
    reloadOnce(attemptIndex, threadIds).pipe(
      Effect.map((unconverged) => ({ unconverged, error: undefined })),
      // A failed request retries the same sessions.
      Effect.catch((error) => Effect.succeed({ unconverged: threadIds, error })),
      Effect.flatMap(({ unconverged, error }) => {
        if (!error && unconverged?.length === 0) return Effect.void;
        const delayMs = retryDelaysMs[attemptIndex];
        if (delayMs === undefined) {
          return Effect.fail(
            error ??
              new ProviderValidationError({
                operation: "reloadMcpConfigForProject",
                issue: `${unconverged?.length ?? 0} live Codex session(s) did not converge on the MCP config.`,
              }),
          );
        }
        return Effect.sleep(Duration.millis(delayMs)).pipe(
          Effect.andThen(reloadWithRetry(attemptIndex + 1, unconverged)),
        );
      }),
    );

  return reloadWithRetry(0, undefined).pipe(
    Effect.as<string | undefined>(undefined),
    Effect.catch((cause) =>
      Effect.logWarning("Codex MCP login succeeded but reloading live sessions failed.", {
        cause,
        projectId: input.projectId,
        serverName: input.serverName,
      }).pipe(Effect.as(CODEX_MCP_LOGIN_RELOAD_FAILURE_MESSAGE)),
    ),
  );
}
