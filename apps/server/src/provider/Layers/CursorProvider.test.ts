import { writeAcpWrapper, waitForAgentExit } from "../../testUtils/cli.ts";
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Path, Schedule } from "effect";
import { describe, expect, it } from "vitest";
import type * as EffectAcpSchema from "effect-acp/schema";
import { ProviderInstanceId, type CursorSettings } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import { ServerConfig } from "../../config.ts";
import { CursorDriver } from "../Drivers/CursorDriver.ts";
import {
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "../providerStatusCache.ts";
import {
  buildCursorProviderSnapshot,
  buildCursorCapabilitiesFromConfigOptions,
  checkCursorProviderStatus,
  cursorModelsFromCatalog,
  fetchCursorModelCatalog,
  getCursorFallbackModels,
  getCursorParameterizedModelPickerUnsupportedMessage,
  parseCursorAboutOutput,
  parseCursorCliConfigChannel,
  parseCursorVersionDate,
  resolveCursorAcpBaseModelId,
  resolveCursorAcpConfigUpdates,
  resolveCursorAcpModelValue,
} from "./CursorProvider.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./ProviderEventLoggers.ts";

const runNode = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

const resolveMockAgentPath = Effect.fn("resolveMockAgentPath")(function* () {
  const path = yield* Path.Path;
  return yield* path.fromFileUrl(new URL("../../../scripts/acp-mock-agent.ts", import.meta.url));
});

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
) {
  return {
    id,
    label,
    type: "select" as const,
    options: [...options],
    ...(options.find((option) => option.isDefault)?.id
      ? { currentValue: options.find((option) => option.isDefault)?.id }
      : {}),
  };
}

function booleanDescriptor(id: string, label: string, currentValue?: boolean) {
  return {
    id,
    label,
    type: "boolean" as const,
    ...(typeof currentValue === "boolean" ? { currentValue } : {}),
  };
}

const makeMockAgentWithAboutWrapper = Effect.fn("makeMockAgentWithAboutWrapper")(function* (
  extraEnv?: Record<string, string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const agent = yield* resolveMockAgentPath();
  const dir = yield* fs.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix: "cursor-provider-about-mock-",
  });
  return writeAcpWrapper(path.join(dir, "fake-agent"), agent, {
    env: extraEnv,
    about: "CLI Version         2026.04.09-f2b0fcd\nUser Email          cursor@example.com\n",
  });
});

const readFileIfPresent = Effect.fn("readFileIfPresent")(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(filePath).pipe(Effect.catch(() => Effect.succeed("")));
});

const makeProviderStatusEnvFixture = Effect.fn("makeProviderStatusEnvFixture")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix: "cursor-provider-status-env-",
  });
  const requestLogPath = path.join(tempDir, "requests.ndjson");
  return {
    requestLogPath,
    wrapperPath: yield* makeMockAgentWithAboutWrapper({
      T3_ACP_REQUEST_LOG_PATH: requestLogPath,
    }),
  };
});

const parameterizedGpt54ConfigOptions = [
  {
    type: "select",
    currentValue: "gpt-5.4-medium-fast",
    options: [{ name: "GPT-5.4", value: "gpt-5.4-medium-fast" }],
    category: "model",
    id: "model",
    name: "Model",
  },
  {
    type: "select",
    currentValue: "medium",
    options: [
      { name: "None", value: "none" },
      { name: "Low", value: "low" },
      { name: "Medium", value: "medium" },
      { name: "High", value: "high" },
      { name: "Extra High", value: "extra-high" },
    ],
    category: "thought_level",
    id: "reasoning",
    name: "Reasoning",
  },
  {
    type: "select",
    currentValue: "272k",
    options: [
      { name: "272K", value: "272k" },
      { name: "1M", value: "1m" },
    ],
    category: "model_config",
    id: "context",
    name: "Context",
  },
  {
    type: "select",
    currentValue: "false",
    options: [
      { name: "Off", value: "false" },
      { name: "Fast", value: "true" },
    ],
    category: "model_config",
    id: "fast",
    name: "Fast",
  },
] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

const parameterizedClaudeConfigOptions = [
  {
    type: "select",
    currentValue: "claude-4.6-opus-high-thinking",
    options: [{ name: "Opus 4.6", value: "claude-4.6-opus-high-thinking" }],
    category: "model",
    id: "model",
    name: "Model",
  },
  {
    type: "select",
    currentValue: "high",
    options: [
      { name: "Low", value: "low" },
      { name: "Medium", value: "medium" },
      { name: "High", value: "high" },
    ],
    category: "thought_level",
    id: "reasoning",
    name: "Reasoning",
  },
  {
    type: "boolean",
    currentValue: true,
    category: "model_config",
    id: "thinking",
    name: "Thinking",
  },
] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

const parameterizedClaudeModelOptionConfigOptions = [
  {
    type: "select",
    currentValue: "claude-opus-4-6",
    options: [{ name: "Opus 4.6", value: "claude-opus-4-6" }],
    category: "model",
    id: "model",
    name: "Model",
  },
  {
    type: "select",
    currentValue: "high",
    options: [
      { name: "Low", value: "low" },
      { name: "Medium", value: "medium" },
      { name: "High", value: "high" },
    ],
    category: "thought_level",
    id: "reasoning",
    name: "Reasoning",
  },
  {
    type: "select",
    currentValue: "max",
    options: [
      { name: "Low", value: "low" },
      { name: "Medium", value: "medium" },
      { name: "High", value: "high" },
      { name: "Max", value: "max" },
    ],
    category: "model_option",
    id: "effort",
    name: "Effort",
  },
  {
    type: "select",
    currentValue: "true",
    options: [
      { name: "Off", value: "false" },
      { name: "Fast", value: "true" },
    ],
    category: "model_config",
    id: "fast",
    name: "Fast",
  },
  {
    type: "select",
    currentValue: "true",
    options: [
      { name: "Off", value: "false" },
      { name: ":icon-brain:", value: "true" },
    ],
    category: "model_config",
    id: "thinking",
    name: "Thinking",
  },
] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

const selectOption = (
  id: string,
  name: string,
  category: string,
  currentValue: string,
  values: ReadonlyArray<readonly [string, string]>,
) => ({
  type: "select" as const,
  id,
  name,
  category,
  currentValue,
  options: values.map(([value, label]) => ({ value, name: label })),
});

/** Shaped like Cursor CLI 2026.11.22's `cursor/list_available_models` response. */
const cursorModelCatalog = {
  models: [
    {
      value: "auto-smart",
      name: "Auto",
      configOptions: [
        selectOption("optimize_for", "Optimize For", "model_config", "balanced", [
          ["balanced", "Balanced"],
          ["speed", "Speed"],
        ]),
      ],
    },
    {
      value: "gemini-4-neon",
      name: "Gemini 4 Neon",
      configOptions: [
        selectOption("reasoning_effort", "Reasoning Effort", "thought_level", "high", [
          ["low", "Low"],
          ["medium", "Medium"],
          ["high", "High"],
          ["xhigh", "Extra High"],
        ]),
        selectOption("context", "Context", "model_config", "300k", [
          ["300k", "300K"],
          ["1m", "1M"],
        ]),
      ],
    },
    {
      value: "claude-opus-4-7",
      name: "Opus 4.7",
      configOptions: [
        selectOption("thinking", "Thinking", "thought_level", "true", [
          ["false", "Off"],
          ["true", "On"],
        ]),
        selectOption("effort", "Effort", "thought_level", "max", [
          ["none", "None"],
          ["low", "Low"],
          ["max", "Max"],
        ]),
        selectOption("fast", "Fast", "model_config", "false", [
          ["false", "Off"],
          ["true", "Fast"],
        ]),
        { type: "select", id: "broken" },
      ],
    },
    { value: "gemini-4-neon", name: "Duplicate", configOptions: [] },
    { value: 5, name: "Malformed" },
    { value: "  ", name: "Blank" },
  ],
};

const baseCursorSettings: CursorSettings = {
  harness: "acp",
  enabled: true,
  binaryPath: "agent",
  apiEndpoint: "",
  customModels: [],
};

const emptyCapabilities = createModelCapabilities({ optionDescriptors: [] });

describe("getCursorFallbackModels", () => {
  it("does not publish any built-in cursor models before ACP discovery", () => {
    expect(
      getCursorFallbackModels({
        customModels: ["internal/cursor-model"],
      }).map((model) => model.slug),
    ).toEqual(["internal/cursor-model"]);
  });
});

describe("buildCursorProviderSnapshot", () => {
  it("keeps ready status when ACP discovery returns no built-in models", () => {
    expect(
      buildCursorProviderSnapshot({
        checkedAt: "2026-01-01T00:00:00.000Z",
        cursorSettings: baseCursorSettings,
        parsed: {
          version: null,
          status: "ready",
          auth: { status: "unknown" },
          message: "Could not verify Cursor Agent authentication status.",
        },
        discoveryWarning: "Cursor ACP model discovery returned no built-in models.",
      }),
    ).toMatchObject({
      status: "ready",
      message:
        "Could not verify Cursor Agent authentication status. Cursor ACP model discovery returned no built-in models.",
      models: [],
    });
  });

  it("downgrades ready status to warning when ACP model discovery times out", () => {
    expect(
      buildCursorProviderSnapshot({
        checkedAt: "2026-01-01T00:00:00.000Z",
        cursorSettings: baseCursorSettings,
        parsed: {
          version: "2026.04.09-f2b0fcd",
          status: "ready",
          auth: { status: "authenticated", type: "Team", label: "Cursor Team Subscription" },
        },
        discoveryWarning: "Cursor ACP model discovery timed out after 15000ms.",
      }),
    ).toMatchObject({
      status: "warning",
      message: "Cursor ACP model discovery timed out after 15000ms.",
      models: [],
    });
  });

  it("preserves provider error state while appending discovery warnings", () => {
    expect(
      buildCursorProviderSnapshot({
        checkedAt: "2026-01-01T00:00:00.000Z",
        cursorSettings: {
          ...baseCursorSettings,
          customModels: ["claude-sonnet-4-6"],
        },
        parsed: {
          version: "2026.04.09-f2b0fcd",
          status: "error",
          auth: { status: "unauthenticated" },
          message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
        },
        discoveryWarning: "Cursor ACP model discovery failed. Check server logs for details.",
      }),
    ).toMatchObject({
      status: "error",
      message:
        "Cursor Agent is not authenticated. Run `agent login` and try again. Cursor ACP model discovery failed. Check server logs for details.",
      models: [
        {
          slug: "claude-sonnet-4-6",
          isCustom: true,
        },
      ],
    });
  });
});

describe("buildCursorCapabilitiesFromConfigOptions", () => {
  it("derives model capabilities from parameterized Cursor ACP config options", () => {
    expect(buildCursorCapabilitiesFromConfigOptions(parameterizedGpt54ConfigOptions)).toEqual(
      createModelCapabilities({
        optionDescriptors: [
          selectDescriptor("reasoning", "Reasoning", [
            { id: "none", label: "None" },
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
            { id: "xhigh", label: "Extra High" },
          ]),
          selectDescriptor("contextWindow", "Context", [
            { id: "272k", label: "272K", isDefault: true },
            { id: "1m", label: "1M" },
          ]),
          booleanDescriptor("fastMode", "Fast", false),
        ],
      }),
    );
  });

  it("detects boolean thinking toggles from model_config options", () => {
    expect(buildCursorCapabilitiesFromConfigOptions(parameterizedClaudeConfigOptions)).toEqual(
      createModelCapabilities({
        optionDescriptors: [
          selectDescriptor("reasoning", "Reasoning", [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High", isDefault: true },
          ]),
          booleanDescriptor("thinking", "Thinking", true),
        ],
      }),
    );
  });

  it("prefers the newer model_option effort control over legacy thought_level", () => {
    expect(
      buildCursorCapabilitiesFromConfigOptions(parameterizedClaudeModelOptionConfigOptions),
    ).toEqual(
      createModelCapabilities({
        optionDescriptors: [
          selectDescriptor("reasoning", "Effort", [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
            { id: "max", label: "Max", isDefault: true },
          ]),
          booleanDescriptor("fastMode", "Fast", true),
          booleanDescriptor("thinking", "Thinking", true),
        ],
      }),
    );
  });
});

describe("cursorModelsFromCatalog", () => {
  it("maps each catalog model with the options Cursor offers for it", () => {
    expect(cursorModelsFromCatalog(cursorModelCatalog)).toEqual([
      // Cursor's Auto is F5's default `auto`. Its optimize_for has no F5 control, so Auto
      // runs with Cursor's default.
      { slug: "auto", name: "Auto", isCustom: false, capabilities: emptyCapabilities },
      {
        slug: "gemini-4-neon",
        name: "Gemini 4 Neon",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            selectDescriptor("reasoning", "Reasoning Effort", [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High", isDefault: true },
              { id: "xhigh", label: "Extra High" },
            ]),
            selectDescriptor("contextWindow", "Context", [
              { id: "300k", label: "300K", isDefault: true },
              { id: "1m", label: "1M" },
            ]),
          ],
        }),
      },
      {
        slug: "claude-opus-4-7",
        name: "Opus 4.7",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            selectDescriptor("reasoning", "Effort", [
              { id: "none", label: "None" },
              { id: "low", label: "Low" },
              { id: "max", label: "Max", isDefault: true },
            ]),
            booleanDescriptor("fastMode", "Fast", false),
            booleanDescriptor("thinking", "Thinking", true),
          ],
        }),
      },
    ]);
  });

  it("reads nothing from a response without a model list", () => {
    expect(cursorModelsFromCatalog({ items: [] })).toEqual([]);
    expect(cursorModelsFromCatalog(null)).toEqual([]);
  });

  it("writes catalog option picks back to the matching session option ids", () => {
    const configOptionsFor = (slug: string) =>
      cursorModelCatalog.models.find((model) => model.value === slug)!
        .configOptions as ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
    expect(
      resolveCursorAcpConfigUpdates(configOptionsFor("gemini-4-neon"), [
        { id: "reasoning", value: "xhigh" },
        { id: "contextWindow", value: "1m" },
      ]),
    ).toEqual([
      { configId: "reasoning_effort", value: "xhigh" },
      { configId: "context", value: "1m" },
    ]);
    expect(
      resolveCursorAcpConfigUpdates(configOptionsFor("claude-opus-4-7").slice(0, 3), [
        { id: "reasoning", value: "none" },
        { id: "fastMode", value: true },
        { id: "thinking", value: false },
      ]),
    ).toEqual([
      { configId: "effort", value: "none" },
      { configId: "fast", value: "true" },
      { configId: "thinking", value: "false" },
    ]);
  });
});

const makeCatalogFixture = Effect.fn("makeCatalogFixture")(function* (catalog: string | undefined) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix: "cursor-provider-catalog-",
  });
  const requestLogPath = path.join(tempDir, "requests.ndjson");
  const exitLogPath = path.join(tempDir, "exit.log");
  return {
    requestLogPath,
    exitLogPath,
    wrapperPath: yield* makeMockAgentWithAboutWrapper({
      T3_ACP_REQUEST_LOG_PATH: requestLogPath,
      T3_ACP_EXIT_LOG_PATH: exitLogPath,
      ...(catalog === undefined ? {} : { T3_ACP_CURSOR_MODEL_CATALOG: catalog }),
    }),
  };
});

const requestedMethods = async (requestLogPath: string) =>
  (await runNode(readFileIfPresent(requestLogPath)))
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { method?: string }).method)
    .filter((method) => method !== undefined);

describe("fetchCursorModelCatalog", () => {
  it("reads the catalog without authenticating or opening a session", async () => {
    const { requestLogPath, exitLogPath, wrapperPath } = await runNode(
      makeCatalogFixture(JSON.stringify(cursorModelCatalog)),
    );

    const result = await Effect.runPromise(
      fetchCursorModelCatalog({ ...baseCursorSettings, binaryPath: wrapperPath }).pipe(
        Effect.provide(NodeServices.layer),
      ),
    );

    expect(result._tag).toBe("ok");
    expect(result._tag === "ok" ? result.models.map((model) => model.slug) : []).toEqual([
      "auto",
      "gemini-4-neon",
      "claude-opus-4-7",
    ]);
    await expect(requestedMethods(requestLogPath)).resolves.toEqual([
      "initialize",
      "cursor/list_available_models",
    ]);
    await waitForAgentExit(exitLogPath);
  });

  it("reports a CLI without the catalog request as unsupported", async () => {
    const { wrapperPath } = await runNode(makeCatalogFixture("unsupported"));
    await expect(
      Effect.runPromise(
        fetchCursorModelCatalog({ ...baseCursorSettings, binaryPath: wrapperPath }).pipe(
          Effect.provide(NodeServices.layer),
        ),
      ),
    ).resolves.toEqual({ _tag: "unsupported" });
  });

  it("redacts credentials from a failed fetch's detail", async () => {
    const { wrapperPath } = await runNode(
      makeCatalogFixture("error:upstream rejected Authorization: Bearer secret-token-123"),
    );
    const result = await Effect.runPromise(
      fetchCursorModelCatalog({ ...baseCursorSettings, binaryPath: wrapperPath }).pipe(
        Effect.provide(NodeServices.layer),
      ),
    );
    expect(result._tag).toBe("failed");
    const detail = result._tag === "failed" ? result.detail : "";
    expect(detail).toContain("upstream rejected");
    expect(detail).not.toContain("secret-token-123");
  });

  it("reports a CLI that cannot start as a failed fetch", async () => {
    const result = await Effect.runPromise(
      fetchCursorModelCatalog(
        { ...baseCursorSettings, binaryPath: "/definitely/missing/f5-cursor-agent" },
        { PATH: "" },
      ).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(result._tag).toBe("failed");
  });
});

describe("checkCursorProviderStatus", () => {
  it("reports a missing binary as unavailable instead of ready", async () => {
    const provider = await Effect.runPromise(
      checkCursorProviderStatus(
        {
          harness: "acp",
          enabled: true,
          binaryPath: "/definitely/missing/f5-cursor-agent",
          apiEndpoint: "",
          customModels: [],
        },
        { PATH: "" },
      ).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(provider.status).toBe("error");
    expect(provider.installed).toBe(false);
    expect(provider.message).toBe("Cursor Agent CLI (`agent`) is not installed or not on PATH.");
  });

  it("keeps provider status passive and does not start ACP", async () => {
    const { requestLogPath, wrapperPath } = await runNode(makeProviderStatusEnvFixture());

    const provider = await Effect.runPromise(
      checkCursorProviderStatus({
        harness: "acp",
        enabled: true,
        binaryPath: wrapperPath,
        apiEndpoint: "",
        customModels: [],
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(provider.status).toBe("ready");
    expect(provider.auth.status).toBe("authenticated");
    expect(provider.version).toBe("2026.04.09-f2b0fcd");
    expect(provider.models.map((model) => model.slug)).toEqual([]);
    await expect(runNode(readFileIfPresent(requestLogPath))).resolves.toBe("");
  });

  it("publishes the account catalog after a passive CursorDriver refresh", async () => {
    const { requestLogPath, wrapperPath } = await runNode(
      makeCatalogFixture(JSON.stringify(cursorModelCatalog)),
    );
    const testLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "cursor-driver-catalog-",
    }).pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const instance = yield* CursorDriver.create({
            instanceId: ProviderInstanceId.make("cursor"),
            displayName: undefined,
            accentColor: undefined,
            environment: [],
            enabled: true,
            config: { ...baseCursorSettings, binaryPath: wrapperPath, customModels: ["mine"] },
          });
          const refreshed = yield* instance.snapshot.refresh;
          expect(refreshed.status).toBe("ready");
          // The status check itself only runs `agent about`; the catalog follows.
          expect(refreshed.models.map((model) => model.slug)).toEqual(["mine"]);
          const enriched = yield* instance.snapshot.getSnapshot.pipe(
            Effect.flatMap((snapshot) =>
              snapshot.models.length > 1
                ? Effect.succeed(snapshot)
                : Effect.fail("catalog not published yet" as const),
            ),
            Effect.retry(Schedule.spaced("50 millis")),
            Effect.timeout("15 seconds"),
          );
          expect(enriched.models.map((model) => model.slug)).toEqual([
            "auto",
            "gemini-4-neon",
            "claude-opus-4-7",
            "mine",
          ]);
          // A later refresh keeps the cached catalog without asking Cursor again.
          const again = yield* instance.snapshot.refresh;
          expect(again.models.map((model) => model.slug)).toEqual(
            enriched.models.map((model) => model.slug),
          );
        }),
      ).pipe(Effect.provide(testLayer)),
    );

    await expect(requestedMethods(requestLogPath)).resolves.toEqual([
      "initialize",
      "cursor/list_available_models",
    ]);
  });

  it("keeps the persisted catalog after a restart whose catalog fetch fails", async () => {
    const working = await runNode(makeCatalogFixture(JSON.stringify(cursorModelCatalog)));
    const failing = await runNode(makeCatalogFixture("error:catalog unavailable"));
    const testLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "cursor-driver-restart-",
    }).pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    );
    const create = (binaryPath: string) =>
      CursorDriver.create({
        instanceId: ProviderInstanceId.make("cursor"),
        displayName: undefined,
        accentColor: undefined,
        environment: [],
        enabled: true,
        config: { ...baseCursorSettings, binaryPath },
      });
    const waitForCatalog = (instance: Effect.Success<ReturnType<typeof create>>) =>
      instance.snapshot.getSnapshot.pipe(
        Effect.flatMap((snapshot) =>
          snapshot.models.length > 1
            ? Effect.succeed(snapshot)
            : Effect.fail("catalog not published yet" as const),
        ),
        Effect.retry(Schedule.spaced("50 millis")),
        Effect.timeout("15 seconds"),
      );

    await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const cacheDir = config.providerStatusCacheDir!;
        // The first process publishes the catalog, which the registry persists.
        const published = yield* Effect.scoped(
          Effect.gen(function* () {
            const instance = yield* create(working.wrapperPath);
            yield* instance.snapshot.refresh;
            return yield* waitForCatalog(instance);
          }),
        );
        yield* writeProviderStatusCache({
          filePath: yield* resolveProviderStatusCachePath({
            cacheDir,
            instanceId: ProviderInstanceId.make("cursor"),
          }),
          provider: published,
        });
        // After a restart the fetch fails, and the last catalog is still shown.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const instance = yield* create(failing.wrapperPath);
            const refreshed = yield* instance.snapshot.refresh;
            expect(refreshed.models.map((model) => model.slug)).toEqual([
              "auto",
              "gemini-4-neon",
              "claude-opus-4-7",
            ]);
          }),
        );
      }).pipe(Effect.provide(testLayer)),
    );
  });
});

describe("parseCursorAboutOutput", () => {
  it("parses json about output and forwards subscription metadata", () => {
    expect(
      parseCursorAboutOutput({
        code: 0,
        stdout: JSON.stringify({
          cliVersion: "2026.04.09-f2b0fcd",
          subscriptionTier: "Team",
          userEmail: "jmarminge@gmail.com",
        }),
        stderr: "",
      }),
    ).toEqual({
      version: "2026.04.09-f2b0fcd",
      status: "ready",
      auth: {
        status: "authenticated",
        email: "jmarminge@gmail.com",
        type: "Team",
        label: "Cursor Team Subscription",
      },
    });
  });

  it("treats json about output with a logged-out email as unauthenticated", () => {
    expect(
      parseCursorAboutOutput({
        code: 0,
        stdout: JSON.stringify({
          cliVersion: "2026.04.09-f2b0fcd",
          subscriptionTier: "Team",
          userEmail: "Not logged in",
        }),
        stderr: "",
      }),
    ).toEqual({
      version: "2026.04.09-f2b0fcd",
      status: "error",
      auth: {
        status: "unauthenticated",
      },
      message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
    });
  });

  it("treats json about output with a null email as unauthenticated", () => {
    expect(
      parseCursorAboutOutput({
        code: 0,
        stdout: JSON.stringify({
          cliVersion: "2026.04.09-f2b0fcd",
          subscriptionTier: null,
          userEmail: null,
        }),
        stderr: "",
      }),
    ).toEqual({
      version: "2026.04.09-f2b0fcd",
      status: "error",
      auth: {
        status: "unauthenticated",
      },
      message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
    });
  });

  it("does not mark unknown auth as provider warning when about exits non-zero", () => {
    expect(
      parseCursorAboutOutput({
        code: 1,
        stdout: JSON.stringify({
          cliVersion: "2026.04.09-f2b0fcd",
          subscriptionTier: "Team",
        }),
        stderr: "User email unavailable",
      }),
    ).toEqual({
      version: "2026.04.09-f2b0fcd",
      status: "ready",
      auth: {
        status: "unknown",
        type: "Team",
        label: "Cursor Team Subscription",
      },
      message: "Could not verify Cursor Agent authentication status.",
    });
  });
});

describe("Cursor parameterized model picker preview gating", () => {
  it("parses Cursor CLI version dates from build versions", () => {
    expect(parseCursorVersionDate("2026.04.08-c4e73a3")).toBe(20260408);
    expect(parseCursorVersionDate("2026.04.09")).toBe(20260409);
    expect(parseCursorVersionDate("not-a-version")).toBeUndefined();
  });

  it("parses the Cursor CLI channel from cli-config.json", () => {
    expect(parseCursorCliConfigChannel('{ "channel": "lab" }')).toBe("lab");
    expect(parseCursorCliConfigChannel('{ "channel": "stable" }')).toBe("stable");
    expect(parseCursorCliConfigChannel('{ "version": 1 }')).toBeUndefined();
    expect(parseCursorCliConfigChannel("not-json")).toBeUndefined();
  });

  it("returns no warning when the preview requirements are met", () => {
    expect(
      getCursorParameterizedModelPickerUnsupportedMessage({
        version: "2026.04.08-c4e73a3",
        channel: "lab",
      }),
    ).toBeUndefined();
  });

  it("explains when the Cursor Agent version is too old", () => {
    expect(
      getCursorParameterizedModelPickerUnsupportedMessage({
        version: "2026.04.07-c4e73a3",
        channel: "lab",
      }),
    ).toContain("too old");
  });

  it("explains when the Cursor Agent channel is not lab", () => {
    expect(
      getCursorParameterizedModelPickerUnsupportedMessage({
        version: "2026.04.08-c4e73a3",
        channel: "stable",
      }),
    ).toContain("lab channel");
  });
});

describe("resolveCursorAcpBaseModelId", () => {
  it("drops bracket traits without rewriting raw ACP model ids", () => {
    expect(resolveCursorAcpBaseModelId("gpt-5.4[reasoning=medium,context=272k]")).toBe("gpt-5.4");
    expect(resolveCursorAcpBaseModelId("gpt-5.4-medium-fast")).toBe("gpt-5.4-medium-fast");
    expect(resolveCursorAcpBaseModelId("claude-4.6-opus-high-thinking")).toBe(
      "claude-4.6-opus-high-thinking",
    );
    expect(resolveCursorAcpBaseModelId("composer-2")).toBe("composer-2");
    expect(resolveCursorAcpBaseModelId("auto")).toBe("default");
  });
});

describe("resolveCursorAcpModelValue", () => {
  const modelOption = (values: ReadonlyArray<string>) => [
    selectOption(
      "model",
      "Model",
      "model",
      values[0]!,
      values.map((value) => [value, value] as const),
    ),
  ];

  it("resolves Auto to whichever auto value the session offers", () => {
    expect(resolveCursorAcpModelValue("auto", modelOption(["auto-smart", "gemini-4-neon"]))).toBe(
      "auto-smart",
    );
    expect(resolveCursorAcpModelValue("auto", modelOption(["default", "composer-2"]))).toBe(
      "default",
    );
    expect(resolveCursorAcpModelValue("auto", [])).toBe("default");
  });

  it("passes every other model id through", () => {
    expect(
      resolveCursorAcpModelValue("gemini-4-neon", modelOption(["auto-smart", "gemini-4-neon"])),
    ).toBe("gemini-4-neon");
  });
});

describe("resolveCursorAcpConfigUpdates", () => {
  it("maps Cursor model options onto separate ACP config option updates", () => {
    expect(
      resolveCursorAcpConfigUpdates(parameterizedGpt54ConfigOptions, [
        { id: "reasoning", value: "xhigh" },
        { id: "fastMode", value: true },
        { id: "contextWindow", value: "1m" },
      ]),
    ).toEqual([
      { configId: "reasoning", value: "extra-high" },
      { configId: "context", value: "1m" },
      { configId: "fast", value: "true" },
    ]);
  });

  it("maps boolean thinking toggles when the model exposes them separately", () => {
    expect(
      resolveCursorAcpConfigUpdates(parameterizedClaudeConfigOptions, [
        { id: "thinking", value: false },
      ]),
    ).toEqual([{ configId: "thinking", value: false }]);
  });

  it("maps explicit fastMode: false so the adapter can clear a prior fast selection", () => {
    expect(
      resolveCursorAcpConfigUpdates(parameterizedGpt54ConfigOptions, [
        { id: "fastMode", value: false },
      ]),
    ).toEqual([{ configId: "fast", value: "false" }]);
  });

  it("writes Cursor effort changes through the newer model_option config when available", () => {
    expect(
      resolveCursorAcpConfigUpdates(parameterizedClaudeModelOptionConfigOptions, [
        { id: "reasoning", value: "max" },
        { id: "thinking", value: false },
      ]),
    ).toEqual([
      { configId: "effort", value: "max" },
      { configId: "thinking", value: "false" },
    ]);
  });
});
