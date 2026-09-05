import { describe, expect, it } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Sink, Stream } from "effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  MODEL_OPTIONS_BY_PROVIDER,
  ProviderInstanceId,
  type ClaudeSettings,
} from "@t3tools/contracts";
import { getReasoningEffortOptions } from "@t3tools/shared/model";

import {
  checkClaudeProviderStatus,
  getClaudeModelCapabilities,
  makePendingClaudeProvider,
  resolveClaudeApiModelId,
  normalizeClaudeCliEffort,
  resolveClaudeEffort,
  VERSION_GATED_CLAUDE_MODELS,
} from "./ClaudeProvider.ts";

const encoder = new TextEncoder();

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockClaudeVersionLayer(version: string) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as { args: ReadonlyArray<string> };
      if (cmd.args.join(" ") !== "--version") {
        return Effect.succeed(
          mockHandle({
            stdout: "",
            stderr: `Unexpected args: ${cmd.args.join(" ")}`,
            code: 1,
          }),
        );
      }
      return Effect.succeed(mockHandle({ stdout: `claude ${version}\n`, stderr: "", code: 0 }));
    }),
  );
}

function mockClaudeSpawnFailureLayer(description: string) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description,
        }),
      ),
    ),
  );
}

const claudeSettings = {
  enabled: true,
  binaryPath: "claude",
  homePath: "",
  customModels: [],
  launchArgs: "",
} satisfies ClaudeSettings;

const capabilitiesProbe = () =>
  Effect.succeed({
    email: "claude@example.com",
    subscriptionType: "ClaudeMaxSubscription",
    tokenSource: undefined,
    slashCommands: [],
  });

function runStatusForVersion(version: string) {
  return Effect.runPromise(
    checkClaudeProviderStatus(claudeSettings, capabilitiesProbe).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, mockClaudeVersionLayer(version))),
    ),
  );
}

function runStatusForVersionWithSettings(version: string, settings: ClaudeSettings) {
  return Effect.runPromise(
    checkClaudeProviderStatus(settings, capabilitiesProbe).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, mockClaudeVersionLayer(version))),
    ),
  );
}

function modelSlugs(snapshot: Awaited<ReturnType<typeof runStatusForVersion>>) {
  return snapshot.models.map((model) => model.slug);
}

function expectGatedModelsVisible(slugs: ReadonlyArray<string>) {
  expect(slugs).toContain("claude-opus-5");
  expect(slugs).toContain("claude-fable-5-1");
  expect(slugs).toContain("claude-fable-5");
  expect(slugs).toContain("claude-sonnet-5");
  expect(slugs).toContain("claude-opus-4-8");
  expect(slugs).toContain("claude-opus-4-7");
}

describe("checkClaudeProviderStatus", () => {
  it("filters Claude Opus 5 and shows its upgrade message before the minimum CLI version", async () => {
    const snapshot = await runStatusForVersion("2.1.169");

    expect(snapshot.status).toBe("ready");
    expect(snapshot.message).toBe(
      "Claude Code v2.1.169 is too old for Claude Fable 5.1. Upgrade to v2.1.257 or newer to access it.",
    );
    expect(modelSlugs(snapshot)).toEqual([
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
  });

  it("uses the Opus 5 upgrade message when the CLI version misses multiple gates", async () => {
    const snapshot = await runStatusForVersion("2.1.153");

    expect(snapshot.status).toBe("ready");
    expect(snapshot.message).toBe(
      "Claude Code v2.1.153 is too old for Claude Fable 5.1. Upgrade to v2.1.257 or newer to access it.",
    );
    expect(modelSlugs(snapshot)).toEqual([
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
  });

  it("uses the Opus 5 upgrade message when a CLI version misses all gated models", async () => {
    const snapshot = await runStatusForVersion("2.1.110");

    expect(snapshot.message).toBe(
      "Claude Code v2.1.110 is too old for Claude Fable 5.1. Upgrade to v2.1.257 or newer to access it.",
    );
    expect(modelSlugs(snapshot)).toEqual([
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
  });

  it("keeps Claude Fable 5 hidden while exposing Claude Opus 4.8 once that gate is met", async () => {
    const snapshot = await runStatusForVersion("2.1.154");

    expect(snapshot.message).toBe(
      "Claude Code v2.1.154 is too old for Claude Fable 5.1. Upgrade to v2.1.257 or newer to access it.",
    );
    expect(modelSlugs(snapshot).slice(0, 2)).toEqual(["claude-opus-4-8", "claude-opus-4-7"]);
  });

  it("keeps Opus 5 gated at Claude Code v2.1.219", async () => {
    const snapshot = await runStatusForVersion("2.1.219");

    expect(snapshot.message).toBe(
      "Claude Code v2.1.219 is too old for Claude Fable 5.1. Upgrade to v2.1.257 or newer to access it.",
    );
    expect(modelSlugs(snapshot)).not.toContain("claude-opus-5");
  });

  it("exposes Claude Opus 5 first at Claude Code v2.1.220", async () => {
    const snapshot = await runStatusForVersion("2.1.220");

    expect(snapshot.message).toContain("Claude Fable 5.1");
    expect(modelSlugs(snapshot).slice(0, 4)).toEqual([
      "claude-opus-5",
      "claude-fable-5",
      "claude-sonnet-5",
      "claude-opus-4-8",
    ]);
  });

  it("preserves the Fable 5.1 upgrade hint when capability probing fails", async () => {
    const snapshot = await Effect.runPromise(
      checkClaudeProviderStatus(claudeSettings, () => Effect.sync(() => undefined)).pipe(
        Effect.provide(Layer.merge(NodeServices.layer, mockClaudeVersionLayer("2.1.219"))),
      ),
    );

    expect(snapshot.status).toBe("warning");
    expect(snapshot.message).toBe(
      "Could not verify Claude authentication status from initialization result. Claude Code v2.1.219 is too old for Claude Fable 5.1. Upgrade to v2.1.257 or newer to access it.",
    );
    expect(modelSlugs(snapshot)).not.toContain("claude-opus-5");
  });

  it("does not claim an upgrade is required when the CLI version is unparseable", async () => {
    const snapshot = await runStatusForVersion("not-a-version");

    expect(snapshot.message).toBeUndefined();
    expectGatedModelsVisible(modelSlugs(snapshot));
  });

  it("keeps Opus 5 gated after the Fable gate is met", async () => {
    const snapshot = await runStatusForVersion("2.1.170");

    expect(snapshot.message).toBe(
      "Claude Code v2.1.170 is too old for Claude Fable 5.1. Upgrade to v2.1.257 or newer to access it.",
    );
    expect(modelSlugs(snapshot).slice(0, 3)).toEqual([
      "claude-fable-5",
      "claude-sonnet-5",
      "claude-opus-4-8",
    ]);
  });

  it("keeps gated models visible in disabled provider snapshots when the version is unknown", async () => {
    const snapshot = await Effect.runPromise(
      checkClaudeProviderStatus({ ...claudeSettings, enabled: false }, capabilitiesProbe).pipe(
        Effect.provide(Layer.merge(NodeServices.layer, mockClaudeVersionLayer("2.1.170"))),
      ),
    );

    expect(snapshot.status).toBe("disabled");
    expectGatedModelsVisible(modelSlugs(snapshot));
  });

  it("keeps gated models visible in spawn-failure snapshots when the version is unknown", async () => {
    const snapshot = await Effect.runPromise(
      checkClaudeProviderStatus(claudeSettings, capabilitiesProbe).pipe(
        Effect.provide(Layer.merge(NodeServices.layer, mockClaudeSpawnFailureLayer("boom"))),
      ),
    );

    expect(snapshot.status).toBe("error");
    expectGatedModelsVisible(modelSlugs(snapshot));
  });

  it("keeps gated aliases out of custom models on unsupported CLI versions", async () => {
    const snapshot = await runStatusForVersionWithSettings("2.1.169", {
      ...claudeSettings,
      customModels: [
        "opus",
        "opus-5",
        "claude-opus-5",
        "claude-opus-5[1m]",
        "fable",
        "claude-fable-5",
        "custom/claude-model",
      ],
    });

    const slugs = modelSlugs(snapshot);
    expect(slugs).not.toContain("claude-opus-5");
    expect(slugs).not.toContain("claude-fable-5");
    expect(slugs).toContain("custom/claude-model");
  });
});

describe("makePendingClaudeProvider", () => {
  it("matches contract membership while preserving the server leading order", () => {
    const slugs = makePendingClaudeProvider(claudeSettings).models.map((model) => model.slug);
    expect(new Set(slugs)).toEqual(
      new Set(MODEL_OPTIONS_BY_PROVIDER.claudeAgent.map((model) => model.slug)),
    );
    expect(slugs.slice(0, 4)).toEqual([
      "claude-opus-5",
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-sonnet-5",
    ]);
    expect(VERSION_GATED_CLAUDE_MODELS[0]).toEqual({
      slug: "claude-fable-5-1",
      name: "Claude Fable 5.1",
      minVersion: "2.1.257",
    });
  });

  it.each(["2.1.256", "2.1.257"])("gates Fable 5.1 and custom aliases at %s", async (version) => {
    const snapshot = await runStatusForVersionWithSettings(version, {
      ...claudeSettings,
      customModels: ["fable", "fable-5.1", "fable-5-1", "claude-fable-5-1[1m]", "fable-5"],
    });
    const slugs = modelSlugs(snapshot);
    expect(slugs.filter((slug) => slug === "claude-fable-5-1")).toHaveLength(
      version === "2.1.257" ? 1 : 0,
    );
    expect(slugs.filter((slug) => slug === "claude-fable-5")).toHaveLength(1);
    if (version === "2.1.256") expect(snapshot.message).toContain("Upgrade to v2.1.257");
    else expect(snapshot.message).toBeUndefined();
  });
  it("keeps gated models visible in pending provider snapshots when the version is unknown", () => {
    const snapshot = makePendingClaudeProvider(claudeSettings);

    expect(snapshot.status).toBe("warning");
    expectGatedModelsVisible(snapshot.models.map((model) => model.slug));
  });

  it("keeps gated aliases visible in pending custom models when the version is unknown", () => {
    const snapshot = makePendingClaudeProvider({
      ...claudeSettings,
      customModels: ["fable", "claude-opus-4-8", "custom/claude-model"],
    });
    const slugs = snapshot.models.map((model) => model.slug);

    expectGatedModelsVisible(slugs);
    expect(slugs).toContain("custom/claude-model");
  });
});

describe("getClaudeModelCapabilities", () => {
  it("uses only effort for Fable 5.1 and strips stale context suffixes on the wire", () => {
    const caps = getClaudeModelCapabilities("fable");
    expect(caps.optionDescriptors?.map((descriptor) => descriptor.id)).toEqual(["effort"]);
    expect(resolveClaudeEffort(caps, undefined)).toBe("high");
    expect(resolveClaudeEffort(caps, "xhigh")).toBe("xhigh");
    expect(normalizeClaudeCliEffort("xhigh")).toBe("xhigh");
    expect(normalizeClaudeCliEffort("ultrathink")).toBeUndefined();
    expect(
      resolveClaudeApiModelId({
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "fable[200k]",
        options: [{ id: "contextWindow", value: "1m" }],
      }),
    ).toBe("claude-fable-5-1");
  });
  it("keeps Opus 5 descriptors aligned with shared metadata", () => {
    const caps = getClaudeModelCapabilities("claude-opus-5");
    const descriptors = caps.optionDescriptors ?? [];
    const effortDescriptor = descriptors.find((descriptor) => descriptor.id === "effort");

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual(["effort", "fastMode"]);
    expect(
      effortDescriptor?.type === "select"
        ? effortDescriptor.options.map((option) => option.id)
        : [],
    ).toEqual(getReasoningEffortOptions("claudeAgent", "claude-opus-5"));
  });

  it("keeps Sonnet 5 server effort options aligned with shared metadata", () => {
    const caps = getClaudeModelCapabilities("claude-sonnet-5");
    const descriptors = caps.optionDescriptors ?? [];
    const effortDescriptor = descriptors.find((descriptor) => descriptor.id === "effort");

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual(["effort", "contextWindow"]);
    expect(
      effortDescriptor?.type === "select"
        ? effortDescriptor.options.map((option) => option.id)
        : [],
    ).toEqual(getReasoningEffortOptions("claudeAgent", "claude-sonnet-5"));
  });

  it("keeps Fable 5 server effort options aligned with shared metadata", () => {
    const caps = getClaudeModelCapabilities("claude-fable-5");
    const descriptors = caps.optionDescriptors ?? [];
    const effortDescriptor = descriptors.find((descriptor) => descriptor.id === "effort");

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual(["effort", "contextWindow"]);
    expect(effortDescriptor?.type).toBe("select");
    expect(
      effortDescriptor?.type === "select"
        ? effortDescriptor.options.map((option) => option.id)
        : [],
    ).toEqual(getReasoningEffortOptions("claudeAgent", "claude-fable-5"));
  });

  it("derives corrected Opus 4.x Fast Mode descriptors from shared metadata", () => {
    expect(
      getClaudeModelCapabilities("claude-opus-4-8").optionDescriptors?.map(
        (descriptor) => descriptor.id,
      ),
    ).toEqual(["effort", "fastMode", "contextWindow"]);
    expect(
      getClaudeModelCapabilities("claude-opus-4-6").optionDescriptors?.map(
        (descriptor) => descriptor.id,
      ),
    ).toEqual(["effort", "contextWindow"]);
    expect(
      getClaudeModelCapabilities("claude-opus-4-5").optionDescriptors?.map(
        (descriptor) => descriptor.id,
      ),
    ).toEqual(["effort"]);
  });
});

describe("resolveClaudeApiModelId", () => {
  it("applies the 1M suffix only to context-window capable Claude models", () => {
    expect(
      resolveClaudeApiModelId({
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-fable-5",
        options: [{ id: "contextWindow", value: "1m" }],
      }),
    ).toBe("claude-fable-5[1m]");
    expect(
      resolveClaudeApiModelId({
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-haiku-4-5",
        options: [{ id: "contextWindow", value: "1m" }],
      }),
    ).toBe("claude-haiku-4-5");
    expect(
      resolveClaudeApiModelId({
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5",
        options: [{ id: "contextWindow", value: "1m" }],
      }),
    ).toBe("claude-opus-5");
  });
});
