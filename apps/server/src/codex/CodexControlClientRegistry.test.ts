import { ServerSettingsService } from "../serverSettings.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import * as OS from "node:os";
import { fallbackDefaultProfile } from "../profiles/ProfileRegistryStore";
import { Cause, Effect, Layer, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  ServerSettings,
} from "@t3tools/contracts";
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

  it("keeps same-home accounts separate, uses the project cwd, and retires stale execution identities", async () => {
    const work = ProviderInstanceId.make("work"),
      personal = ProviderInstanceId.make("personal");
    const projectId = ProjectId.makeUnsafe("identity-project");
    const clients: CodexControlClient[] = [];
    const create = vi.spyOn(CodexControlClient, "create").mockImplementation(async () => {
      const client = makeFakeControlClient(`client-${clients.length}`);
      clients.push(client);
      return client;
    });
    const settingsLayer = ServerSettingsService.layerTest(
      Schema.decodeUnknownSync(ServerSettings)({
        providerInstances: {
          [work]: {
            driver: ProviderDriverKind.make("codex"),
            config: { homePath: "/tmp/same-home", binaryPath: "codex" },
            environment: [{ name: "ACCOUNT_LABEL", value: "work" }],
          },
          [personal]: {
            driver: ProviderDriverKind.make("codex"),
            config: { homePath: "/tmp/same-home", binaryPath: "codex" },
            environment: [{ name: "ACCOUNT_LABEL", value: "personal" }],
          },
        },
      }),
    );
    const projectLayer = ProjectionProjectRepositoryLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const layer = CodexControlClientRegistryLive.pipe(
      Layer.provideMerge(settingsLayer),
      Layer.provideMerge(projectLayer),
      Layer.provideMerge(Layer.succeed(ServerConfig, makeServerConfigStub())),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* CodexControlClientRegistry;
          const settings = yield* ServerSettingsService;
          const projects = yield* ProjectionProjectRepository;
          const project = {
            projectId,
            title: "MCP project",
            workspaceRoot: "/tmp/project-a",
            defaultModel: null,
            scripts: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            deletedAt: null,
          };
          yield* projects.upsert(project);
          const input = { projectId, instanceId: work, mcpEffectiveConfigVersion: "v1" };
          const first = yield* registry.getAdminClient(input);
          const other = yield* registry.getAdminClient({ ...input, instanceId: personal });
          expect(first).not.toBe(other);
          expect(create.mock.calls[0]?.[0]).toMatchObject({
            cwd: "/tmp/project-a",
            homePath: "/tmp/same-home",
            processEnvironment: { ACCOUNT_LABEL: "work" },
          });
          expect(create.mock.calls[1]?.[0]).toMatchObject({
            processEnvironment: { ACCOUNT_LABEL: "personal" },
          });
          // Cosmetic edits keep the connection; environment edits replace only this instance.
          const current = yield* settings.getSettings;
          yield* settings.updateSettings({
            providerInstances: {
              ...current.providerInstances,
              [work]: { ...current.providerInstances[work]!, displayName: "Work renamed" },
            },
          });
          expect(yield* registry.getAdminClient(input)).toBe(first);
          const renamed = yield* settings.getSettings;
          yield* settings.updateSettings({
            providerInstances: {
              ...renamed.providerInstances,
              [work]: {
                ...renamed.providerInstances[work]!,
                environment: [{ name: "ACCOUNT_LABEL", value: "work-new" }],
              },
            },
          });
          const changed = yield* registry.getAdminClient(input);
          expect(changed).not.toBe(first);
          expect(first.close).toHaveBeenCalled();
          expect(other.close).not.toHaveBeenCalled();
          const lease = yield* registry.acquireOauthClient({ ...input, serverName: "docs" });
          yield* projects.upsert({ ...project, workspaceRoot: "/tmp/project-b" });
          const moved = yield* registry.getAdminClient(input);
          expect(moved).not.toBe(changed);
          expect(lease.client.closeAndWait).toHaveBeenCalled();
          expect(changed.close).toHaveBeenCalled();
          expect(create.mock.calls.at(-1)?.[0]).toMatchObject({ cwd: "/tmp/project-b" });
          expect(yield* registry.hasOauthLease({ ...input, serverName: "docs" })).toBe(false);
        }).pipe(Effect.provide(layer)),
      ),
    );
  });

  it("keeps identity monitoring alive after an OAuth cleanup rejects", async () => {
    const instanceId = ProviderInstanceId.make("monitor-work");
    const projectId = ProjectId.makeUnsafe("monitor-project");
    vi.spyOn(CodexControlClient, "create").mockImplementation(async () =>
      makeFakeControlClient("monitor"),
    );
    const layer = CodexControlClientRegistryLive.pipe(
      Layer.provideMerge(
        ServerSettingsService.layerTest(
          Schema.decodeUnknownSync(ServerSettings)({
            providerInstances: {
              [instanceId]: { driver: ProviderDriverKind.make("codex"), config: {} },
            },
          }),
        ),
      ),
      Layer.provideMerge(
        ProjectionProjectRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory)),
      ),
      Layer.provideMerge(Layer.succeed(ServerConfig, makeServerConfigStub())),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* CodexControlClientRegistry;
          const settings = yield* ServerSettingsService;
          const projects = yield* ProjectionProjectRepository;
          const project = {
            projectId,
            title: "Monitor",
            workspaceRoot: "/tmp/monitor-a",
            defaultModel: null,
            scripts: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            deletedAt: null,
          };
          yield* projects.upsert(project);
          const input = { projectId, instanceId, mcpEffectiveConfigVersion: "v1" };
          const lease = yield* registry.acquireOauthClient({ ...input, serverName: "docs" });
          vi.mocked(lease.client.closeAndWait).mockRejectedValueOnce(
            new Error("simulated cleanup rejection"),
          );
          // A settings event causes the cleanup defect; later events must still be handled.
          const current = yield* settings.getSettings;
          yield* settings.updateSettings({
            providerInstances: {
              ...current.providerInstances,
              [instanceId]: {
                ...current.providerInstances[instanceId]!,
                environment: [{ name: "ACCOUNT_LABEL", value: "changed" }],
              },
            },
          });
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(lease.client.closeAndWait).toHaveBeenCalled()),
          );
          const afterFailure = yield* registry.getAdminClient(input);
          const changed = yield* settings.getSettings;
          yield* settings.updateSettings({
            providerInstances: {
              ...changed.providerInstances,
              [instanceId]: {
                ...changed.providerInstances[instanceId]!,
                environment: [{ name: "ACCOUNT_LABEL", value: "changed-again" }],
              },
            },
          });
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(afterFailure.close).toHaveBeenCalled()),
          );
          const beforeMove = yield* registry.getAdminClient(input);
          yield* projects.upsert({ ...project, workspaceRoot: "/tmp/monitor-b" });
          // Project changes have no settings event and exercise the periodic watcher.
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(beforeMove.close).toHaveBeenCalled(), { timeout: 3500 }),
          );
        }).pipe(Effect.provide(layer)),
      ),
    );
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
