import * as FS from "node:fs/promises";
import * as Path from "node:path";
import * as OS from "node:os";
import { fallbackDefaultProfile } from "../profiles/ProfileRegistryStore";
import { Cause, Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectId } from "@t3tools/contracts";
import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { CodexControlClient } from "./CodexControlClient.ts";
import {
  CodexControlClientRegistry,
  CodexControlClientRegistryLive,
  CodexControlClientRegistryError,
  readCodexControlEnvironmentConfig,
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
    acpHardeningEnabled: false,
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
    closeAndWait: vi.fn(async () => {}),
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

  it("includes MCP OAuth callback port in the Codex control environment", () => {
    expect(
      readCodexControlEnvironmentConfig(
        {
          projectId: ProjectId.makeUnsafe("project-registry-env"),
          providerOptions: {
            codex: {
              binaryPath: "/tmp/codex",
              launchArgs: ["--enable=feature"],
            },
          },
          mcpServers: {},
          mcpOAuthCallbackPort: 3118,
          mcpOAuthCallbackUrl: "http://127.0.0.1:3118/callback",
        },
        "/tmp/repo",
      ),
    ).toEqual({
      cwd: "/tmp/repo",
      binaryPath: "/tmp/codex",
      launchArgs: ["--enable=feature"],
      mcpServers: {},
      mcpOAuthCallbackPort: 3118,
      mcpOAuthCallbackUrl: "http://127.0.0.1:3118/callback",
    });
  });

  it("holds one installation OAuth lease until the owned client exits", async () => {
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

        const conflict = yield* Effect.exit(
          registry.acquireOauthClient({
            projectId: projectB,
            serverName: "filesystem",
            mcpServers: {},
          }),
        );
        expect(conflict._tag).toBe("Failure");
        yield* leaseA.release;
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

it("runs a newer Codex MCP control client with a managed home and file credentials", async () => {
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-new-codex-"));
  const home = Path.join(root, "provider-homes", "codex");
  const log = Path.join(root, "calls.jsonl");
  const binary = Path.join(root, "codex.cjs");
  await FS.mkdir(home, { recursive: true });
  await FS.writeFile(
    binary,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, home: process.env.CODEX_HOME}) + "\\n");
if (args.includes("--version")) console.log("codex-cli 0.147.0");
else require("node:readline").createInterface({input: process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  if (request.id !== undefined) console.log(JSON.stringify({id: request.id, result: {}}));
});
`,
    { mode: 0o700 },
  );
  const server = {
    ...makeServerConfigStub(),
    cwd: root,
    stateDir: root,
    profile: { ...fallbackDefaultProfile(root), isDefault: false },
  };
  const layer = CodexControlClientRegistryLive.pipe(
    Layer.provideMerge(Layer.succeed(ServerConfig, server)),
  );
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* CodexControlClientRegistry;
          const client = yield* registry.getAdminClient({
            projectId: ProjectId.makeUnsafe("newer-codex"),
            providerOptions: { codex: { binaryPath: binary, homePath: home } },
            mcpEffectiveConfigVersion: "v1",
            mcpServers: {},
          });
          expect(client.capabilities).toEqual({ configRead: true, listMcpServerStatus: true });
          yield* Effect.promise(() => client.closeAndWait());
        }).pipe(Effect.provide(layer)),
      ),
    );
    const calls = (await FS.readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; home: string });
    const session = calls.find((call) => call.args.includes("app-server"));
    expect(session?.home).toBe(home);
    expect(session?.args).toContain('cli_auth_credentials_store="file"');
  } finally {
    await FS.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
