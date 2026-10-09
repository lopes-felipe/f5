import { type ProjectId, type ProviderStartOptions } from "@t3tools/contracts";
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
  // This loop owns the retries: one reload per attempt, and per-session
  // warnings only on the last attempt so a login posts them once.
  const reloadOnce = (attemptIndex: number) =>
    input.providerService
      .reloadMcpConfigForProject({
        provider: "codex",
        projectId: input.projectId,
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
        retry: false,
        warn: attemptIndex >= retryDelaysMs.length,
      })
      .pipe(
        Effect.flatMap((outcome) => {
          // A restart-required session is final; it restarts at its next turn.
          const unconverged = outcome.sessions.filter(
            (session) => !session.result.converged && !session.result.restartRequired,
          );
          return unconverged.length === 0
            ? Effect.void
            : Effect.fail(
                new ProviderValidationError({
                  operation: "reloadMcpConfigForProject",
                  issue: `${unconverged.length} live Codex session(s) did not converge on the MCP config.`,
                }),
              );
        }),
      );

  const reloadWithRetry = (attemptIndex: number): Effect.Effect<void, ProviderServiceError> =>
    reloadOnce(attemptIndex).pipe(
      Effect.catch((cause) => {
        const delayMs = retryDelaysMs[attemptIndex];
        if (delayMs === undefined) {
          return Effect.fail(cause);
        }

        return Effect.sleep(Duration.millis(delayMs)).pipe(
          Effect.andThen(reloadWithRetry(attemptIndex + 1)),
        );
      }),
    );

  return reloadWithRetry(0).pipe(
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
