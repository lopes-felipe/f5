import { type ProjectId, type ProviderStartOptions } from "@t3tools/contracts";
import { Duration, Effect } from "effect";

import type { ProviderServiceError } from "../provider/Errors.ts";
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
  const reloadOnce = () =>
    input.providerService.reloadMcpConfigForProject({
      provider: "codex",
      projectId: input.projectId,
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    });

  const reloadWithRetry = (attemptIndex: number): Effect.Effect<void, ProviderServiceError> =>
    reloadOnce().pipe(
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
