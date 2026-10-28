import {
  AGENTS_WS_METHODS,
  DEFAULT_SERVER_SETTINGS,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  USAGE_WS_METHODS,
  WS_METHODS,
  type KeybindingsConfig,
  type ResolvedKeybindingsConfig,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { Effect, Layer, PubSub, Semaphore, Stream } from "effect";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type OpenShape } from "./open";
import { ProviderValidationBusyError } from "./provider/Errors.ts";
import type { ProviderInstance } from "./provider/ProviderDriver.ts";
import { type HarnessValidationShape } from "./provider/Services/HarnessValidation";
import { ProviderInstanceRegistry } from "./provider/Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "./provider/Services/ProviderService";
import {
  ProviderUpdateRunError,
  type ProviderUpdateAdvisorShape,
} from "./provider/Services/ProviderUpdateAdvisor.ts";
import {
  emptyAccountSection,
  makeAccountUsageCapability,
} from "./usage/Layers/AccountUsageService.ts";
import {
  compileMergedKeybindings,
  connectAndAwaitWelcome,
  createWsServerTestHarness,
  DEFAULT_RESOLVED_KEYBINDINGS,
  defaultProviderRegistryService,
  defaultProviderService,
  defaultProviderSnapshots,
  defaultProviderUpdateAdvisorService,
  expectAvailableEditors,
  rewriteKeybindingsAndWaitForPush,
  sendRequest,
} from "./wsServer.testHarness.ts";

describe("WebSocket Server", () => {
  const h = createWsServerTestHarness();
  const { connections, makeTempDir, createTestServer } = h;

  it.each(["binaryPath", "homePath"])("rejects client-supplied %s in MCP Apply", async (field) => {
    h.server = await createTestServer({ cwd: "/test/project" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    const response = await sendRequest(ws, WS_METHODS.mcpApplyToLiveSessions, {
      scope: "common",
      [field]: "/tmp/untrusted",
    });
    expect(response.error?.message).toContain("Invalid request format");
    expect(response.error?.message).toContain(`["body"]["${field}"]`);
    expect(response.result).toBeUndefined();
  });

  it.each(["claudeAgent", "codex"] as const)(
    "discovers MCP reconnect targets only for Codex: %s",
    async (provider) => {
      const getMcpReconnectTargets = vi.fn(() =>
        Effect.succeed({
          threadIds: [],
          failures: [
            {
              threadId: ThreadId.make("stale-conversation"),
              message: "The provider session no longer exists.",
            },
          ],
        }),
      );
      h.server = await createTestServer({
        providerLayer: Layer.succeed(ProviderService, {
          ...defaultProviderService,
          getMcpReconnectTargets,
        }),
      });
      const addr = h.server.address();
      const [ws] = await connectAndAwaitWelcome(typeof addr === "object" && addr ? addr.port : 0);
      connections.push(ws);
      const response = await sendRequest(ws, WS_METHODS.mcpReconnectServer, {
        provider,
        instanceId: provider,
        projectId: "reconnect-project",
        serverName: "docs",
      });
      expect(response.error).toBeUndefined();
      expect(getMcpReconnectTargets).toHaveBeenCalledTimes(provider === "codex" ? 1 : 0);
      expect(response.result).toMatchObject({
        settingsConnectionReloaded: true,
        sessionsReconnected: 0,
        failures:
          provider === "codex"
            ? [
                {
                  threadId: "stale-conversation",
                  message: "The provider session no longer exists.",
                },
              ]
            : [],
      });
    },
  );

  it("returns a bounded usage summary with explicit coverage", async () => {
    h.server = await createTestServer({ cwd: "/test/project" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    const response = await sendRequest(ws, USAGE_WS_METHODS.getSummary, {
      range: "24h",
      timeZone: "UTC",
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual(
      expect.objectContaining({
        range: "24h",
        timeZone: "UTC",
        metrics: expect.objectContaining({ turnCount: 0, providerReportedCostUsd: null }),
        buckets: expect.arrayContaining([expect.objectContaining({ metrics: expect.any(Object) })]),
        coverage: expect.objectContaining({ coverageStartedAt: expect.any(String) }),
      }),
    );
    expect((response.result as { buckets: unknown[] }).buckets).toHaveLength(24);
    const accounts = await sendRequest(ws, USAGE_WS_METHODS.getAccounts, { refresh: "none" });
    expect(accounts.error).toBeUndefined();
    // This server has no registered instances. Never synthesize a legacy
    // machine-account probe outside the active profile's provider registry.
    expect(accounts.result).toEqual([]);
    const refreshedAccounts = await sendRequest(ws, USAGE_WS_METHODS.getAccounts, {
      refresh: "force",
    });
    expect(refreshedAccounts.error).toBeUndefined();
    expect(refreshedAccounts.result).toEqual([]);
    expect(response.result).not.toHaveProperty("codexAccount");
    const history = await sendRequest(ws, USAGE_WS_METHODS.getQuotaHistory, {});
    expect(history.error).toBeUndefined();
    expect(history.result).toEqual({ generatedAt: expect.any(String), series: [] });
  });

  it("routes thread-scoped agent snapshots and dismissals", async () => {
    h.server = await createTestServer({ cwd: "/test/project" });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    const global = await sendRequest(ws, AGENTS_WS_METHODS.getSnapshot, {});
    expect(global.error).toBeUndefined();
    expect(global.result).toEqual({ entries: [], generatedAt: expect.any(String) });

    const scoped = await sendRequest(ws, AGENTS_WS_METHODS.getSnapshot, {
      threadId: "thread-agents",
    });
    expect(scoped.error).toBeUndefined();
    expect(scoped.result).toEqual({ entries: [], generatedAt: expect.any(String) });

    const dismissed = await sendRequest(ws, AGENTS_WS_METHODS.dismiss, {
      threadId: "thread-agents",
      workItemIds: ["task-1"],
    });
    expect(dismissed.error).toBeUndefined();
    expect(dismissed.result).toEqual({ dismissedCount: 0 });

    const invalid = await sendRequest(ws, AGENTS_WS_METHODS.dismiss, { workItemIds: [""] });
    expect(invalid.error).toBeDefined();
  });

  it.each([
    ["reset", false, false],
    ["alreadyRedeemed", false, false],
    ["nothingToReset", false, false],
    ["noCredit", false, false],
    ["reset", true, false],
    ["alreadyRedeemed", true, false],
    ["reset", true, true],
    ["reset", true, true, true],
  ] as const)(
    "refreshes after reset-credit outcome %s (recent refresh: %s; elapsed retry hint: %s) with the real account throttle",
    async (outcome, recentRefresh, elapsedRetryHint, persistentRefusal: boolean = false) => {
      const instanceId = ProviderInstanceId.makeUnsafe("claudeAgent-credit-test");
      let refreshCalls = 0;
      let probeCalls = 0;
      const registryLayer = Layer.effect(
        ProviderInstanceRegistry,
        Effect.gen(function* () {
          const capability = yield* makeAccountUsageCapability(
            {
              key: instanceId,
              provider: "claudeAgent",
              providerInstanceId: instanceId,
              displayName: "Credit test",
              enabled: true,
              refreshState: "idle",
              sections: [emptyAccountSection("claude-usage")],
            },
            Effect.sync(() => {
              probeCalls++;
              const fetchedAt = new Date().toISOString();
              return [
                {
                  kind: "claude-usage" as const,
                  outcome: "available" as const,
                  lastAttemptAt: fetchedAt,
                  errorCode: null,
                  snapshot: {
                    fetchedAt,
                    data: {
                      subscriptionLabel: "Max",
                      limitsAvailable: true,
                      windows: [],
                      extraUsage: null,
                    },
                  },
                },
              ];
            }),
            { identity: "test:claude" },
          );
          const instance = {
            instanceId,
            driverKind: ProviderDriverKind.make("claudeAgent"),
            continuationIdentity: {
              driverKind: ProviderDriverKind.make("claudeAgent"),
              continuationKey: instanceId,
            },
            displayName: undefined,
            snapshot: {
              getSnapshot: Effect.succeed(defaultProviderSnapshots[0]!),
              refresh: Effect.succeed(defaultProviderSnapshots[0]!),
              streamChanges: Stream.empty,
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
            enabled: true,
            consumeResetCredit: () =>
              Effect.gen(function* () {
                if (recentRefresh) yield* capability.refreshAccount!(yield* Semaphore.make(2));
                return { outcome };
              }),
            accountUsage: {
              ...capability,
              refreshAccount: (permits) => {
                refreshCalls++;
                if (persistentRefusal)
                  return Effect.succeed({
                    snapshot: null,
                    fresh: false,
                    nextAllowedAt: new Date(0).toISOString(),
                  });
                const refresh = capability.refreshAccount!(permits);
                // Reproduce crossing the deadline between capability refusal and
                // the route inspecting its hint. Keep the real five-second gate.
                return elapsedRetryHint && refreshCalls === 1
                  ? refresh.pipe(
                      Effect.map((reply) => ({
                        ...reply,
                        nextAllowedAt: new Date(0).toISOString(),
                      })),
                    )
                  : refresh;
              },
            },
          } as ProviderInstance;
          return {
            getInstance: (id) => Effect.succeed(id === instanceId ? instance : undefined),
            listInstances: Effect.succeed([instance]),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown).pipe(
              Effect.flatMap(PubSub.subscribe),
            ),
          };
        }),
      );
      h.server = await createTestServer({ providerInstanceRegistryLayer: registryLayer });
      const address = h.server.address();
      const [ws] = await connectAndAwaitWelcome(
        typeof address === "object" && address ? address.port : 0,
      );
      connections.push(ws);
      const response = await sendRequest(ws, USAGE_WS_METHODS.consumeResetCredit, {
        providerInstanceId: instanceId,
        idempotencyKey: "credit-route-test",
      });
      expect(response.error).toBeUndefined();
      expect(response.result).toEqual({ outcome });
      expect(refreshCalls).toBe(1);
      expect(probeCalls).toBe(1);
      if (persistentRefusal) {
        await vi.waitFor(() => expect(refreshCalls).toBe(4));
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(refreshCalls).toBe(4);
        expect(probeCalls).toBe(1);
      } else if (recentRefresh) {
        // The response arrives while the real capability is throttled. The
        // scoped retry must perform a second probe after its five-second gate.
        await vi.waitFor(() => expect(probeCalls).toBe(2), { timeout: 7000 });
        // A timer can wake just before the gate, causing another refused
        // in-memory refresh attempt. The real probe count must still be exactly two.
        expect(refreshCalls).toBeGreaterThanOrEqual(2);
      }
    },
    15000,
  );

  it("resolves project settings over files, replaces overrides and prunes deleted projects", async () => {
    const workspaceRoot = makeTempDir("f5-project-scope-");
    fs.writeFileSync(
      path.join(workspaceRoot, "f5.json"),
      JSON.stringify({ defaultRuntimeMode: "approval-required", worktreeSubmodules: "none" }),
    );
    h.server = await createTestServer({ cwd: workspaceRoot });
    const address = h.server.address();
    const [ws] = await connectAndAwaitWelcome(
      typeof address === "object" && address ? address.port : 0,
    );
    connections.push(ws);
    const projectId = "scoped-project";
    const createdAt = new Date().toISOString();
    expect(
      (
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "project.create",
          commandId: "scope-project-create",
          projectId,
          title: "Scoped",
          workspaceRoot,
          defaultModel: "gpt-5",
          createdAt,
        })
      ).error,
    ).toBeUndefined();
    const original = await sendRequest(ws, WS_METHODS.serverGetProjectSettings, { projectId });
    expect(original.error).toBeUndefined();
    expect(original.result).toMatchObject({
      settings: { defaultRuntimeMode: "approval-required", worktreeSubmodules: "none" },
      sources: { defaultRuntimeMode: "f5.json" },
    });
    expect(
      (
        await sendRequest(ws, WS_METHODS.serverUpdateSettings, {
          projectSettingsOverrides: { [projectId]: { defaultRuntimeMode: "full-access" } },
        })
      ).error,
    ).toBeUndefined();
    expect(
      (await sendRequest(ws, WS_METHODS.serverGetProjectSettings, { projectId })).result,
    ).toMatchObject({
      settings: { defaultRuntimeMode: "full-access" },
      sources: { defaultRuntimeMode: "project" },
    });
    expect(
      (
        await sendRequest(ws, WS_METHODS.serverUpdateSettings, {
          projectSettingsOverrides: { [projectId]: { enableAssistantStreaming: true } },
        })
      ).error,
    ).toBeUndefined();
    expect(
      (await sendRequest(ws, WS_METHODS.serverGetProjectSettings, { projectId })).result,
    ).toMatchObject({
      overrides: { enableAssistantStreaming: true },
      settings: { defaultRuntimeMode: "approval-required" },
    });
    expect(
      (
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "project.delete",
          commandId: "scope-project-delete",
          projectId,
          deletedAt: createdAt,
        })
      ).error,
    ).toBeUndefined();
    await expect
      .poll(
        async () =>
          (
            (await sendRequest(ws, WS_METHODS.serverGetConfig)).result as {
              settings: ServerSettings;
            }
          ).settings.projectSettingsOverrides[projectId as ProjectId],
      )
      .toBeUndefined();
    expect(
      (await sendRequest(ws, WS_METHODS.serverGetProjectSettings, { projectId })).error,
    ).toBeDefined();
  });

  it("responds to server.getConfig", async () => {
    const stateDir = makeTempDir("t3code-state-get-config-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    fs.writeFileSync(keybindingsPath, "[]", "utf8");

    h.server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      keybindingsConfigPath: keybindingsPath,
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      customKeybindings: [],
      issues: [],
      providers: defaultProviderSnapshots,
      settings: DEFAULT_SERVER_SETTINGS,
      diagnostics: {
        traces: { endpoint: null, source: "unset", protocol: "http/protobuf" },
        metrics: { endpoint: null, source: "unset", protocol: "http/protobuf" },
      },
      availableEditors: expect.any(Array),
    });
    expect(
      (response.result as { keybindings: ResolvedKeybindingsConfig }).keybindings.some(
        (entry) => entry.command === "thread.switchRecentNext" && entry.shortcut.key === "tab",
      ),
    ).toBe(true);
    expect(
      (response.result as { keybindings: ResolvedKeybindingsConfig }).keybindings.some(
        (entry) =>
          entry.command === "thread.switchRecentPrevious" &&
          entry.shortcut.key === "tab" &&
          entry.shortcut.shiftKey,
      ),
    ).toBe(true);
    expectAvailableEditors((response.result as { availableEditors: unknown }).availableEditors);
  });

  it("redacts server settings secrets in server.getConfig", async () => {
    const stateDir = makeTempDir("t3code-state-get-config-redacted-");
    const instanceId = ProviderInstanceId.make("codex_personal");
    fs.writeFileSync(
      path.join(stateDir, "settings.json"),
      JSON.stringify(
        {
          observability: {
            otlpHeaders: [{ name: "Authorization", value: "collector-private-header" }],
          },
          providers: {
            opencode: {
              serverPassword: "server-password",
            },
          },
          providerInstances: {
            [instanceId]: {
              driver: "opencode",
              config: {
                serverPassword: "instance-password",
              },
              environment: [
                {
                  name: "OPENAI_API_KEY",
                  value: "sk-secret",
                  sensitive: true,
                },
              ],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    h.server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(JSON.stringify(response.result)).not.toContain("collector-private-header");
    const settings = (response.result as { settings: ServerSettings }).settings;
    expect(settings.providers.opencode.serverPassword).toBe("");
    expect(settings.providerInstances[instanceId]?.config).toMatchObject({
      serverPassword: "",
    });
    expect(settings.providerInstances[instanceId]?.environment).toEqual([
      {
        name: "OPENAI_API_KEY",
        value: "",
        sensitive: true,
        valueRedacted: true,
      },
    ]);
  });

  it("refreshes only the requested provider when verifying one installation", async () => {
    const refresh = vi.spyOn(defaultProviderRegistryService, "refresh");
    const refreshInstance = vi.spyOn(defaultProviderRegistryService, "refreshInstance");
    try {
      h.server = await createTestServer();
      const addr = h.server.address();
      const [ws] = await connectAndAwaitWelcome(typeof addr === "object" && addr ? addr.port : 0);
      connections.push(ws);
      const response = await sendRequest(ws, WS_METHODS.serverRefreshProviders, {
        instanceId: "codex",
      });
      expect(response.error).toBeUndefined();
      expect(refreshInstance).toHaveBeenCalledWith("codex");
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      refresh.mockRestore();
      refreshInstance.mockRestore();
    }
  });

  it("keeps health refresh independent and awaits explicit update checks", async () => {
    let finished = false;
    const refreshAdvisories = vi.fn<ProviderUpdateAdvisorShape["refreshAdvisories"]>(() =>
      Effect.promise(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        finished = true;
      }),
    );
    h.server = await createTestServer({
      providerUpdateAdvisor: { ...defaultProviderUpdateAdvisorService, refreshAdvisories },
    });
    const addr = h.server.address();
    const [ws] = await connectAndAwaitWelcome(typeof addr === "object" && addr ? addr.port : 0);
    connections.push(ws);
    const health = await sendRequest(ws, WS_METHODS.serverRefreshProviders);
    expect(health.error).toBeUndefined();
    expect(refreshAdvisories).not.toHaveBeenCalled();
    const checked = await sendRequest(ws, WS_METHODS.serverCheckProviderUpdates, {
      instanceId: "codex",
    });
    expect(checked.error).toBeUndefined();
    expect(finished).toBe(true);
    expect(refreshAdvisories).toHaveBeenCalledWith({ mode: "explicit", instanceId: "codex" });
    expect(checked.result).toEqual({ providers: defaultProviderSnapshots });
  });

  it("returns provider update results with decorated providers and maps admission errors", async () => {
    const result = {
      instanceId: ProviderInstanceId.make("codex"),
      outcome: "updated" as const,
      previousVersion: "1.0.0",
      currentVersion: "1.1.0",
      exitCode: 0,
      timedOut: false,
      output: "installed",
      outputTruncated: false,
    };
    let reject = false;
    const runUpdate = vi.fn<ProviderUpdateAdvisorShape["runUpdate"]>(() =>
      reject
        ? Effect.fail(new ProviderUpdateRunError({ message: "Provider has active work." }))
        : Effect.succeed(result),
    );
    h.server = await createTestServer({
      providerUpdateAdvisor: { ...defaultProviderUpdateAdvisorService, runUpdate },
    });
    const addr = h.server.address();
    const [ws] = await connectAndAwaitWelcome(typeof addr === "object" && addr ? addr.port : 0);
    connections.push(ws);
    const updated = await sendRequest(ws, WS_METHODS.serverRunProviderUpdate, {
      instanceId: "codex",
    });
    expect(updated.error).toBeUndefined();
    expect(updated.result).toEqual({ ...result, providers: defaultProviderSnapshots });
    expect(runUpdate).toHaveBeenCalledWith("codex");
    reject = true;
    const refused = await sendRequest(ws, WS_METHODS.serverRunProviderUpdate, {
      instanceId: "codex",
    });
    expect(refused.error).toMatchObject({ message: "Provider has active work." });
  });

  it("routes server.validateHarnesses through the harness validation service", async () => {
    const validateHarnesses = vi.fn<HarnessValidationShape["validate"]>((input) =>
      Effect.succeed([
        {
          provider: "claudeAgent",
          status: "ready",
          installed: true,
          authStatus: "authenticated",
          checkedAt: "2026-01-01T00:00:00.000Z",
          version: "1.0.0",
          ...(input?.providerOptions?.claudeAgent ? { message: "Claude ready." } : {}),
        },
        {
          provider: "codex",
          status: "error",
          installed: true,
          authStatus: "unknown",
          failureKind: "connectivity",
          checkedAt: "2026-01-01T00:00:00.000Z",
          message: "Codex one-off prompt query timed out.",
        },
      ]),
    );

    h.server = await createTestServer({
      cwd: "/my/workspace",
      harnessValidation: {
        validate: validateHarnesses,
      },
    });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.serverValidateHarnesses, {
      providerOptions: {
        codex: {
          binaryPath: "/tmp/custom-codex",
          homePath: "/tmp/.codex",
        },
        claudeAgent: {
          binaryPath: "/tmp/custom-claude",
        },
      },
    });

    expect(response.error).toBeUndefined();
    expect(validateHarnesses).toHaveBeenCalledWith({
      providerOptions: {
        codex: {
          binaryPath: "/tmp/custom-codex",
          homePath: "/tmp/.codex",
        },
        claudeAgent: {
          binaryPath: "/tmp/custom-claude",
        },
      },
    });
    expect(response.result).toEqual({
      results: [
        {
          provider: "claudeAgent",
          status: "ready",
          installed: true,
          authStatus: "authenticated",
          checkedAt: "2026-01-01T00:00:00.000Z",
          version: "1.0.0",
          message: "Claude ready.",
        },
        {
          provider: "codex",
          status: "error",
          installed: true,
          authStatus: "unknown",
          failureKind: "connectivity",
          checkedAt: "2026-01-01T00:00:00.000Z",
          message: "Codex one-off prompt query timed out.",
        },
      ],
    });
  });

  it("returns a deterministic error when harness validation is already in progress", async () => {
    h.server = await createTestServer({
      cwd: "/my/workspace",
      harnessValidation: {
        validate: () =>
          Effect.fail(
            new ProviderValidationBusyError({
              message: "Harness validation is already in progress.",
            }),
          ),
      },
    });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.serverValidateHarnesses);

    expect(response.result).toBeUndefined();
    expect(response.error).toEqual({
      message: "Harness validation is already in progress.",
    });
  });

  it("bootstraps default keybindings file when missing", async () => {
    const stateDir = makeTempDir("t3code-state-bootstrap-keybindings-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    expect(fs.existsSync(keybindingsPath)).toBe(false);

    h.server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      keybindingsConfigPath: keybindingsPath,
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      customKeybindings: [],
      issues: [],
      providers: defaultProviderSnapshots,
      settings: DEFAULT_SERVER_SETTINGS,
      diagnostics: {
        traces: { endpoint: null, source: "unset", protocol: "http/protobuf" },
        metrics: { endpoint: null, source: "unset", protocol: "http/protobuf" },
      },
      availableEditors: expect.any(Array),
    });
    expectAvailableEditors((response.result as { availableEditors: unknown }).availableEditors);

    const persistedConfig = JSON.parse(
      fs.readFileSync(keybindingsPath, "utf8"),
    ) as KeybindingsConfig;
    expect(persistedConfig).toEqual([]);
  });

  it("falls back to defaults and reports malformed keybindings config issues", async () => {
    const stateDir = makeTempDir("t3code-state-malformed-keybindings-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    fs.writeFileSync(keybindingsPath, "{ not-json", "utf8");

    h.server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      keybindingsConfigPath: keybindingsPath,
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      customKeybindings: [],
      issues: [
        {
          kind: "keybindings.malformed-config",
          message: expect.stringContaining("expected JSON array"),
        },
      ],
      providers: defaultProviderSnapshots,
      settings: DEFAULT_SERVER_SETTINGS,
      diagnostics: {
        traces: { endpoint: null, source: "unset", protocol: "http/protobuf" },
        metrics: { endpoint: null, source: "unset", protocol: "http/protobuf" },
      },
      availableEditors: expect.any(Array),
    });
    expectAvailableEditors((response.result as { availableEditors: unknown }).availableEditors);
    expect(fs.readFileSync(keybindingsPath, "utf8")).toBe("{ not-json");
  });

  it("ignores invalid keybinding entries but keeps valid entries and reports issues", async () => {
    const stateDir = makeTempDir("t3code-state-partial-invalid-keybindings-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    fs.writeFileSync(
      keybindingsPath,
      JSON.stringify([
        { key: "mod+j", command: "terminal.toggle" },
        { key: "mod+shift+d+o", command: "terminal.new" },
        { key: "mod+x", command: "not-a-real-command" },
      ]),
      "utf8",
    );

    h.server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    const result = response.result as {
      cwd: string;
      keybindingsConfigPath: string;
      keybindings: ResolvedKeybindingsConfig;
      issues: Array<{ kind: string; index?: number; message: string }>;
      providers: ReadonlyArray<ServerProvider>;
      availableEditors: unknown;
    };
    expect(result.cwd).toBe("/my/workspace");
    expect(result.keybindingsConfigPath).toBe(keybindingsPath);
    expect(result.issues).toEqual([
      {
        kind: "keybindings.invalid-entry",
        index: 1,
        message: expect.any(String),
      },
      {
        kind: "keybindings.invalid-entry",
        index: 2,
        message: expect.any(String),
      },
    ]);
    expect(result.keybindings).toHaveLength(DEFAULT_RESOLVED_KEYBINDINGS.length);
    expect(result.keybindings.some((entry) => entry.command === "terminal.toggle")).toBe(true);
    expect(result.keybindings.some((entry) => entry.command === "terminal.new")).toBe(true);
    expect(result.providers).toEqual(defaultProviderSnapshots);
    expectAvailableEditors(result.availableEditors);
  });

  it("pushes server.configUpdated issues when keybindings file changes", async () => {
    const stateDir = makeTempDir("t3code-state-keybindings-watch-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    fs.writeFileSync(keybindingsPath, "[]", "utf8");

    h.server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const malformedPush = await rewriteKeybindingsAndWaitForPush(
      ws,
      keybindingsPath,
      "{ not-json",
      (push) =>
        Array.isArray(push.data.issues) &&
        Boolean(push.data.issues[0]) &&
        push.data.issues[0]!.kind === "keybindings.malformed-config",
    );
    expect(malformedPush.data).toEqual({
      source: "keybindings",
      issues: [{ kind: "keybindings.malformed-config", message: expect.any(String) }],
      providers: defaultProviderSnapshots,
      settings: DEFAULT_SERVER_SETTINGS,
    });

    const successPush = await rewriteKeybindingsAndWaitForPush(
      ws,
      keybindingsPath,
      "[]",
      (push) => Array.isArray(push.data.issues) && push.data.issues.length === 0,
    );
    expect(successPush.data).toEqual({
      source: "keybindings",
      issues: [],
      providers: defaultProviderSnapshots,
      settings: DEFAULT_SERVER_SETTINGS,
    });
  });

  it("routes shell.openInEditor through the injected open service", async () => {
    const openCalls: Array<{ cwd: string; editor: string }> = [];
    const openService: OpenShape = {
      openBrowser: () => Effect.void,
      openInEditor: (input) => {
        openCalls.push({ cwd: input.cwd, editor: input.editor });
        return Effect.void;
      },
      revealInFileManager: () => Effect.void,
    };

    h.server = await createTestServer({ cwd: "/my/workspace", open: openService });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.shellOpenInEditor, {
      cwd: "/my/workspace",
      editor: "cursor",
    });
    expect(response.error).toBeUndefined();
    expect(openCalls).toEqual([{ cwd: "/my/workspace", editor: "cursor" }]);
  });

  it("routes shell.revealInFileManager through the injected open service", async () => {
    const workspaceRoot = makeTempDir("t3code-reveal-workspace-");
    fs.mkdirSync(path.join(workspaceRoot, "src"));
    fs.writeFileSync(path.join(workspaceRoot, "src", "app.ts"), "export {};\n", "utf8");
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: workspaceRoot, stdio: "pipe" });
    git("init", "-q", "--initial-branch=main");
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "initial",
    );
    const revealCalls: string[] = [];
    const openService: OpenShape = {
      openBrowser: () => Effect.void,
      openInEditor: () => Effect.void,
      revealInFileManager: (targetPath) => {
        revealCalls.push(targetPath);
        return Effect.void;
      },
    };
    h.server = await createTestServer({ cwd: workspaceRoot, open: openService });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);
    const createdAt = new Date().toISOString();
    const projectId = "project-reveal";
    const threadId = "thread-reveal";
    expect(
      (
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "project.create",
          commandId: "cmd-project-reveal",
          projectId,
          title: "Reveal project",
          workspaceRoot,
          defaultModel: "gpt-5-codex",
          createdAt,
        })
      ).error,
    ).toBeUndefined();
    expect(
      (
        await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
          type: "thread.create",
          commandId: "cmd-thread-reveal",
          threadId,
          projectId,
          title: "Reveal thread",
          model: "gpt-5-codex",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        })
      ).error,
    ).toBeUndefined();

    const response = await sendRequest(ws, WS_METHODS.shellRevealInFileManager, {
      projectId,
      threadId,
      relativePath: "src/app.ts",
      kind: "file",
    });
    expect(response.error).toBeUndefined();
    expect(revealCalls).toEqual([path.join(fs.realpathSync(workspaceRoot), "src", "app.ts")]);
    const rootResponse = await sendRequest(ws, WS_METHODS.shellRevealInFileManager, {
      projectId,
      threadId,
      relativePath: ".",
      kind: "directory",
    });
    expect(rootResponse.error).toBeUndefined();
    expect(revealCalls[1]).toBe(fs.realpathSync(workspaceRoot));
    const escapeResponse = await sendRequest(ws, WS_METHODS.shellRevealInFileManager, {
      projectId,
      threadId,
      relativePath: "..",
      kind: "directory",
    });
    expect(escapeResponse.error).toBeDefined();
    expect(revealCalls).toHaveLength(2);
    const external = makeTempDir("t3code-reveal-external-");
    fs.writeFileSync(path.join(external, "report.json"), "{}");
    const localReveal = await sendRequest(ws, WS_METHODS.shellRevealInFileManager, {
      projectId,
      threadId,
      cwd: external,
      relativePath: "report.json",
      kind: "file",
    });
    expect(localReveal.error).toBeUndefined();
    expect(revealCalls[2]).toBe(path.join(fs.realpathSync(external), "report.json"));
    for (const input of [
      { cwd: "relative-directory", relativePath: "report.json", kind: "file" },
      { cwd: external, relativePath: ".", kind: "directory" },
    ]) {
      const denied = await sendRequest(ws, WS_METHODS.shellRevealInFileManager, {
        projectId,
        threadId,
        ...input,
      });
      expect(denied.error).toBeDefined();
    }
    for (const relativePath of ["missing.json", "../report.json"]) {
      const rejected = await sendRequest(ws, WS_METHODS.shellRevealInFileManager, {
        projectId,
        threadId,
        cwd: external,
        relativePath,
        kind: "file",
      });
      expect(rejected.error).toBeDefined();
    }
    fs.symlinkSync(workspaceRoot, path.join(external, "escape"), "dir");
    const symlinkEscape = await sendRequest(ws, WS_METHODS.shellRevealInFileManager, {
      projectId,
      threadId,
      cwd: external,
      relativePath: "escape/src/app.ts",
      kind: "file",
    });
    expect(symlinkEscape.error).toBeDefined();
    expect(revealCalls).toHaveLength(3);
    const inventory = await sendRequest(ws, WS_METHODS.worktreesList, { projectId });
    expect(inventory.error).toBeUndefined();
    expect(inventory.result).toMatchObject({
      projects: [
        {
          projectId,
          entries: [
            {
              classification: "projectCheckout",
              branch: "main",
              missing: false,
              hasChanges: false,
              linkedThreads: [{ threadId, title: "Reveal thread", archived: false }],
            },
          ],
        },
      ],
    });
    const unknown = await sendRequest(ws, WS_METHODS.worktreesList, { projectId: "unknown" });
    expect(unknown.error).toBeDefined();
  });

  it("reads keybindings from the configured state directory", async () => {
    const stateDir = makeTempDir("t3code-state-keybindings-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    fs.writeFileSync(
      keybindingsPath,
      JSON.stringify([
        { key: "mod+y", command: "terminal.toggle" },
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]),
      "utf8",
    );
    h.server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    const persistedConfig = JSON.parse(
      fs.readFileSync(keybindingsPath, "utf8"),
    ) as KeybindingsConfig;
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      keybindingsConfigPath: keybindingsPath,
      keybindings: compileMergedKeybindings(persistedConfig),
      customKeybindings: persistedConfig,
      issues: [],
      providers: defaultProviderSnapshots,
      settings: DEFAULT_SERVER_SETTINGS,
      diagnostics: {
        traces: { endpoint: null, source: "unset", protocol: "http/protobuf" },
        metrics: { endpoint: null, source: "unset", protocol: "http/protobuf" },
      },
      availableEditors: expect.any(Array),
    });
    expectAvailableEditors((response.result as { availableEditors: unknown }).availableEditors);
  });

  it("upserts keybinding rules and updates cached server config", async () => {
    const stateDir = makeTempDir("t3code-state-upsert-keybinding-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    fs.writeFileSync(
      keybindingsPath,
      JSON.stringify([{ key: "mod+j", command: "terminal.toggle" }]),
      "utf8",
    );

    h.server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = h.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const [ws] = await connectAndAwaitWelcome(port);
    connections.push(ws);

    const upsertResponse = await sendRequest(ws, WS_METHODS.serverUpsertKeybinding, {
      key: "mod+shift+r",
      command: "script.run-tests.run",
    });
    expect(upsertResponse.error).toBeUndefined();
    const persistedConfig = JSON.parse(
      fs.readFileSync(keybindingsPath, "utf8"),
    ) as KeybindingsConfig;
    const persistedCommands = new Set(persistedConfig.map((entry) => entry.command));
    expect(persistedConfig).toHaveLength(1);
    expect(persistedCommands.has("script.run-tests.run")).toBe(true);
    expect(upsertResponse.result).toEqual({
      keybindings: compileMergedKeybindings(persistedConfig),
      customKeybindings: persistedConfig,
      issues: [],
    });

    const configResponse = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(configResponse.error).toBeUndefined();
    expect(configResponse.result).toEqual({
      cwd: "/my/workspace",
      keybindingsConfigPath: keybindingsPath,
      keybindings: compileMergedKeybindings(persistedConfig),
      customKeybindings: persistedConfig,
      issues: [],
      providers: defaultProviderSnapshots,
      settings: DEFAULT_SERVER_SETTINGS,
      diagnostics: {
        traces: { endpoint: null, source: "unset", protocol: "http/protobuf" },
        metrics: { endpoint: null, source: "unset", protocol: "http/protobuf" },
      },
      availableEditors: expect.any(Array),
    });
    expectAvailableEditors(
      (configResponse.result as { availableEditors: unknown }).availableEditors,
    );
  });
});
