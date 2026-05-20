import { ProjectId } from "@t3tools/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderValidationError } from "../provider/Errors.ts";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import {
  CODEX_MCP_LOGIN_RELOAD_FAILURE_MESSAGE,
  reloadCodexMcpConfigAfterLogin,
} from "./reloadCodexMcpConfigAfterLogin.ts";

const projectId = ProjectId.makeUnsafe("project-login-reload");

describe("reloadCodexMcpConfigAfterLogin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries a transient post-login MCP reload failure", async () => {
    let calls = 0;
    const reloadMcpConfigForProject = vi.fn<ProviderServiceShape["reloadMcpConfigForProject"]>(
      () => {
        calls += 1;
        return calls === 1
          ? Effect.fail(
              new ProviderValidationError({
                operation: "reloadMcpConfigForProject",
                issue: "token not ready",
              }),
            )
          : Effect.void;
      },
    );

    const result = Effect.runPromise(
      reloadCodexMcpConfigAfterLogin({
        providerService: { reloadMcpConfigForProject },
        projectId,
        serverName: "Observability",
        retryDelaysMs: [1],
      }),
    );

    await expect(result).resolves.toBeUndefined();
    expect(reloadMcpConfigForProject).toHaveBeenCalledTimes(2);
  });

  it("returns the manual retry message after all post-login reload attempts fail", async () => {
    const reloadMcpConfigForProject = vi.fn<ProviderServiceShape["reloadMcpConfigForProject"]>(() =>
      Effect.fail(
        new ProviderValidationError({
          operation: "reloadMcpConfigForProject",
          issue: "initialize response was not ready",
        }),
      ),
    );

    const result = Effect.runPromise(
      reloadCodexMcpConfigAfterLogin({
        providerService: { reloadMcpConfigForProject },
        projectId,
        serverName: "Observability",
        retryDelaysMs: [1, 1],
      }),
    );

    await expect(result).resolves.toBe(CODEX_MCP_LOGIN_RELOAD_FAILURE_MESSAGE);
    expect(reloadMcpConfigForProject).toHaveBeenCalledTimes(3);
  });
});
