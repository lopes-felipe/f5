import { ProjectId, ThreadId } from "@t3tools/contracts";
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
          : Effect.succeed({ sessions: [] });
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

  it("treats a session that did not converge as a failed reload", async () => {
    const reloadMcpConfigForProject = vi.fn<ProviderServiceShape["reloadMcpConfigForProject"]>(() =>
      Effect.succeed({
        sessions: [
          {
            threadId: ThreadId.makeUnsafe("thread-1"),
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
    expect(reloadMcpConfigForProject).toHaveBeenCalledTimes(2);
    // The service's own backoff is off, and only the last attempt warns.
    expect(reloadMcpConfigForProject.mock.calls.map(([call]) => [call.retry, call.warn])).toEqual([
      [false, false],
      [false, true],
    ]);
  });

  it("does not retry or report failure for a session that needs a restart", async () => {
    const reloadMcpConfigForProject = vi.fn<ProviderServiceShape["reloadMcpConfigForProject"]>(() =>
      Effect.succeed({
        sessions: [
          {
            threadId: ThreadId.makeUnsafe("thread-1"),
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
