import { Cause, Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectId } from "@t3tools/contracts";
import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { CodexControlClient } from "./CodexControlClient.ts";
import {
  CodexControlClientRegistry,
  CodexControlClientRegistryLive,
  CodexControlClientRegistryError,
} from "./CodexControlClientRegistry.ts";

function makeServerConfigStub(): ServerConfigShape {
  return {
    mode: "web",
    port: 0,
    host: undefined,
    cwd: "/tmp/f3-code",
    baseDir: "/tmp/f3-code",
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: false,
    authToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    observabilityEnabled: false,
    stateDir: "/tmp/f3-code/state",
    dbPath: "/tmp/f3-code/state.sqlite",
    keybindingsConfigPath: "/tmp/f3-code/keybindings.json",
    worktreesDir: "/tmp/f3-code/worktrees",
    attachmentsDir: "/tmp/f3-code/attachments",
    logsDir: "/tmp/f3-code/logs",
    serverLogPath: "/tmp/f3-code/logs/server.log",
    providerLogsDir: "/tmp/f3-code/logs/provider",
    providerEventLogPath: "/tmp/f3-code/logs/provider/events.log",
    terminalLogsDir: "/tmp/f3-code/logs/terminal",
    anonymousIdPath: "/tmp/f3-code/anonymous-id",
  };
}

function makeFakeControlClient(label: string) {
  return {
    label,
    capabilities: {
      configRead: true,
      listMcpServerStatus: true,
    },
    close: vi.fn(),
  } as unknown as CodexControlClient;
}

async function runRegistryEffect<T, E>(effect: Effect.Effect<T, E, CodexControlClientRegistry>) {
  const layer = CodexControlClientRegistryLive.pipe(
    Layer.provideMerge(Layer.succeed(ServerConfig, makeServerConfigStub())),
  );
  return await Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(layer))));
}

describe("CodexControlClientRegistry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pools admin clients by project, Codex environment, and MCP config version", async () => {
    const createSpy = vi
      .spyOn(CodexControlClient, "create")
      .mockResolvedValueOnce(makeFakeControlClient("a1"))
      .mockResolvedValueOnce(makeFakeControlClient("a2"))
      .mockResolvedValueOnce(makeFakeControlClient("a3"));

    const projectA = ProjectId.makeUnsafe("project-registry-a");
    const projectB = ProjectId.makeUnsafe("project-registry-b");

    const result = await runRegistryEffect(
      Effect.gen(function* () {
        const registry = yield* CodexControlClientRegistry;
        const first = yield* registry.getAdminClient({
          projectId: projectA,
          providerOptions: {
            codex: {
              binaryPath: "/tmp/codex",
            },
          },
          mcpEffectiveConfigVersion: "v1",
          mcpServers: {},
        });
        const second = yield* registry.getAdminClient({
          projectId: projectA,
          providerOptions: {
            codex: {
              binaryPath: "/tmp/codex",
            },
          },
          mcpEffectiveConfigVersion: "v1",
          mcpServers: {},
        });
        const differentProject = yield* registry.getAdminClient({
          projectId: projectB,
          providerOptions: {
            codex: {
              binaryPath: "/tmp/codex",
            },
          },
          mcpEffectiveConfigVersion: "v1",
          mcpServers: {},
        });
        const differentVersion = yield* registry.getAdminClient({
          projectId: projectA,
          providerOptions: {
            codex: {
              binaryPath: "/tmp/codex",
            },
          },
          mcpEffectiveConfigVersion: "v2",
          mcpServers: {},
        });

        return {
          first,
          second,
          differentProject,
          differentVersion,
        };
      }),
    );

    expect(createSpy).toHaveBeenCalledTimes(3);
    expect(result.second).toBe(result.first);
    expect(result.differentProject).not.toBe(result.first);
    expect(result.differentVersion).not.toBe(result.first);
  });

  it("limits OAuth leases per project/env/server while allowing different projects", async () => {
    const createSpy = vi
      .spyOn(CodexControlClient, "create")
      .mockResolvedValueOnce(makeFakeControlClient("lease-a"))
      .mockResolvedValueOnce(makeFakeControlClient("lease-b"));

    const projectA = ProjectId.makeUnsafe("project-registry-oauth-a");
    const projectB = ProjectId.makeUnsafe("project-registry-oauth-b");

    await runRegistryEffect(
      Effect.gen(function* () {
        const registry = yield* CodexControlClientRegistry;
        const leaseA = yield* registry.acquireOauthClient({
          projectId: projectA,
          serverName: "filesystem",
          providerOptions: {
            codex: {
              binaryPath: "/tmp/codex",
            },
          },
          mcpEffectiveConfigVersion: "v1",
          mcpServers: {},
        });

        expect(
          yield* registry.hasOauthLease({
            projectId: projectA,
            serverName: "filesystem",
            providerOptions: {
              codex: {
                binaryPath: "/tmp/codex",
              },
            },
            mcpEffectiveConfigVersion: "v1",
            mcpServers: {},
          }),
        ).toBe(true);

        const duplicate = yield* Effect.exit(
          registry.acquireOauthClient({
            projectId: projectA,
            serverName: "filesystem",
            providerOptions: {
              codex: {
                binaryPath: "/tmp/codex",
              },
            },
            mcpEffectiveConfigVersion: "v1",
            mcpServers: {},
          }),
        );
        expect(duplicate._tag).toBe("Failure");
        if (duplicate._tag === "Failure") {
          const duplicateError = Cause.squash(duplicate.cause);
          expect(duplicateError).toBeInstanceOf(CodexControlClientRegistryError);
          if (duplicateError instanceof Error) {
            expect(duplicateError.message).toContain("already pending");
          }
        }

        const leaseB = yield* registry.acquireOauthClient({
          projectId: projectB,
          serverName: "filesystem",
          providerOptions: {
            codex: {
              binaryPath: "/tmp/codex",
            },
          },
          mcpEffectiveConfigVersion: "v1",
          mcpServers: {},
        });

        expect(createSpy).toHaveBeenCalledTimes(2);

        yield* leaseA.release;
        yield* leaseB.release;

        expect(
          yield* registry.hasOauthLease({
            projectId: projectA,
            serverName: "filesystem",
            providerOptions: {
              codex: {
                binaryPath: "/tmp/codex",
              },
            },
            mcpEffectiveConfigVersion: "v1",
            mcpServers: {},
          }),
        ).toBe(false);
      }),
    );
  });
});
