import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
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

  it("delegates account-targeted retry backoff to the service's session gate", async () => {
    const reloadMcpConfigForProject = vi.fn<ProviderServiceShape["reloadMcpConfigForProject"]>(() =>
      Effect.succeed({ sessions: [] }),
    );
    const instanceId = ProviderInstanceId.make("work");
    const result = await Effect.runPromise(
      reloadCodexMcpConfigAfterLogin({
        providerService: { reloadMcpConfigForProject },
        projectId,
        instanceId,
        retryDelaysMs: [1, 3],
      }),
    );
    expect(result).toBeUndefined();
    expect(reloadMcpConfigForProject).toHaveBeenCalledExactlyOnceWith({
      provider: "codex",
      projectId,
      instanceId,
      retryDelaysMs: [1, 3],
    });
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
    expect(reloadMcpConfigForProject).toHaveBeenCalledTimes(1);
  });

  it("treats a session that did not converge as a failed reload", async () => {
    const reloadMcpConfigForProject = vi.fn<ProviderServiceShape["reloadMcpConfigForProject"]>(() =>
      Effect.succeed({
        sessions: [
          {
            threadId: ThreadId.makeUnsafe("thread-1"),
            instanceId: "codex" as import("@t3tools/contracts").ProviderInstanceId,
            generation: 0,
            requestedVersion: "v1",
            attemptedVersion: "v1",
            disposition: "failed" as const,
            result: {
              converged: false,
              restartRequired: false,
              servers: [],
              errors: [{ server: "Observability", message: "needs login" }],
            },
          },
        ],
      }),
    );

    const result = Effect.runPromise(
      reloadCodexMcpConfigAfterLogin({
        providerService: { reloadMcpConfigForProject },
        projectId,
        serverName: "Observability",
        retryDelaysMs: [1],
      }),
    );

    await expect(result).resolves.toBe(CODEX_MCP_LOGIN_RELOAD_FAILURE_MESSAGE);
    expect(reloadMcpConfigForProject).toHaveBeenCalledTimes(1);
    expect(reloadMcpConfigForProject.mock.calls[0]?.[0]).toMatchObject({ retryDelaysMs: [1] });
  });

  it("does not retry or report failure for a session that needs a restart", async () => {
    const reloadMcpConfigForProject = vi.fn<ProviderServiceShape["reloadMcpConfigForProject"]>(() =>
      Effect.succeed({
        sessions: [
          {
            threadId: ThreadId.makeUnsafe("thread-1"),
            instanceId: "codex" as import("@t3tools/contracts").ProviderInstanceId,
            generation: 0,
            requestedVersion: "v1",
            attemptedVersion: "v1",
            disposition: "failed" as const,
            result: {
              converged: false,
              restartRequired: true,
              servers: [],
              errors: [{ message: "Codex fixes its MCP servers when the session starts." }],
            },
          },
        ],
      }),
    );

    const result = Effect.runPromise(
      reloadCodexMcpConfigAfterLogin({
        providerService: { reloadMcpConfigForProject },
        projectId,
        serverName: "Observability",
        retryDelaysMs: [1, 1],
      }),
    );

    await expect(result).resolves.toBeUndefined();
    expect(reloadMcpConfigForProject).toHaveBeenCalledTimes(1);
  });
});
