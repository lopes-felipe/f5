import { describe, expect, it } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Sink, Stream } from "effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ProviderInstanceId, type ClaudeSettings } from "@t3tools/contracts";
import { getReasoningEffortOptions } from "@t3tools/shared/model";

import {
  checkClaudeProviderStatus,
  getClaudeModelCapabilities,
  makePendingClaudeProvider,
  resolveClaudeApiModelId,
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
  expect(slugs).toContain("claude-fable-5");
  expect(slugs).toContain("claude-sonnet-5");
  expect(slugs).toContain("claude-opus-4-8");
  expect(slugs).toContain("claude-opus-4-7");
}

describe("checkClaudeProviderStatus", () => {
  it("filters Claude Fable 5 and shows its upgrade message before the minimum CLI version", async () => {
    const snapshot = await runStatusForVersion("2.1.169");

    expect(snapshot.status).toBe("ready");
    expect(snapshot.message).toBe(
      "Claude Code v2.1.169 is too old for Claude Fable 5. Upgrade to v2.1.170 or newer to access it.",
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

  it("uses the Fable upgrade message when the CLI version only misses the newest gate", async () => {
    const snapshot = await runStatusForVersion("2.1.153");

    expect(snapshot.status).toBe("ready");
    expect(snapshot.message).toBe(
      "Claude Code v2.1.153 is too old for Claude Fable 5. Upgrade to v2.1.170 or newer to access it.",
    );
    expect(modelSlugs(snapshot)).toEqual([
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
  });

  it("uses the Fable upgrade message when a CLI version misses all gated models", async () => {
    const snapshot = await runStatusForVersion("2.1.110");

    expect(snapshot.message).toBe(
      "Claude Code v2.1.110 is too old for Claude Fable 5. Upgrade to v2.1.170 or newer to access it.",
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
      "Claude Code v2.1.154 is too old for Claude Fable 5. Upgrade to v2.1.170 or newer to access it.",
    );
    expect(modelSlugs(snapshot).slice(0, 2)).toEqual(["claude-opus-4-8", "claude-opus-4-7"]);
  });

  it("exposes Claude Fable 5 first once the CLI version supports it", async () => {
    const snapshot = await runStatusForVersion("2.1.170");

    expect(snapshot.message).toBeUndefined();
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
      customModels: ["fable", "claude-fable-5", "custom/claude-model"],
    });

    const slugs = modelSlugs(snapshot);
    expect(slugs).not.toContain("claude-fable-5");
    expect(slugs).toContain("custom/claude-model");
  });
});

describe("makePendingClaudeProvider", () => {
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
  });
});
