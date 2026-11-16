import {
  type ProjectId,
  type ProviderInstanceId,
  type ProviderStartOptions,
} from "@t3tools/contracts";
import { Effect } from "effect";

import { ProviderValidationError } from "../provider/Errors.ts";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";

export const CODEX_MCP_LOGIN_RELOAD_RETRY_DELAYS_MS = [1_000, 3_000, 5_000] as const;

export const CODEX_MCP_LOGIN_RELOAD_FAILURE_MESSAGE =
  "Login completed, but reloading live Codex sessions failed. Apply the shared MCP config to live sessions to retry.";

export function reloadCodexMcpConfigAfterLogin(input: {
  readonly providerService: Pick<ProviderServiceShape, "reloadMcpConfigForProject">;
  readonly projectId: ProjectId;
  readonly instanceId?: ProviderInstanceId;
  readonly serverName?: string;
  readonly providerOptions?: ProviderStartOptions;
  readonly retryDelaysMs?: ReadonlyArray<number>;
}) {
  // The service owns the gate, snapshot, and all retries. Retrying this call here
  // would release the gate and could pick up a different version or generation.
  const reload = input.providerService
    .reloadMcpConfigForProject({
      provider: "codex",
      projectId: input.projectId,
      ...(input.instanceId ? { instanceId: input.instanceId } : {}),
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      retryDelaysMs: input.retryDelaysMs ?? CODEX_MCP_LOGIN_RELOAD_RETRY_DELAYS_MS,
    })
    .pipe(
      Effect.flatMap((outcome) => {
        const failed = outcome.sessions.filter(
          (session) =>
            session.disposition !== "superseded" &&
            !session.result.converged &&
            !session.result.restartRequired,
        );
        return failed.length === 0
          ? Effect.void
          : Effect.fail(
              new ProviderValidationError({
                operation: "reloadMcpConfigForProject",
                issue: `${failed.length} live Codex session(s) did not converge on the MCP config.`,
              }),
            );
      }),
    );
  return reload.pipe(
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
