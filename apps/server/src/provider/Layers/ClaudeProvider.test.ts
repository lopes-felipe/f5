import { describe, expect, it } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ClaudeSettings } from "@t3tools/contracts";

import { checkClaudeProviderStatus } from "./ClaudeProvider.ts";

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

describe("checkClaudeProviderStatus", () => {
  it("filters Claude Opus 4.8 and shows its upgrade message before the minimum CLI version", async () => {
    const snapshot = await runStatusForVersion("2.1.153");

    expect(snapshot.status).toBe("ready");
    expect(snapshot.message).toBe(
      "Claude Code v2.1.153 is too old for Claude Opus 4.8. Upgrade to v2.1.154 or newer to access it.",
    );
    expect(snapshot.models.map((model) => model.slug)).toEqual([
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
  });

  it("uses the Opus 4.8 upgrade message when a CLI version misses both Opus gates", async () => {
    const snapshot = await runStatusForVersion("2.1.110");

    expect(snapshot.message).toBe(
      "Claude Code v2.1.110 is too old for Claude Opus 4.8. Upgrade to v2.1.154 or newer to access it.",
    );
    expect(snapshot.models.map((model) => model.slug)).toEqual([
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
  });

  it("exposes Claude Opus 4.8 first once the CLI version supports it", async () => {
    const snapshot = await runStatusForVersion("2.1.154");

    expect(snapshot.message).toBeUndefined();
    expect(snapshot.models.slice(0, 2).map((model) => model.slug)).toEqual([
      "claude-opus-4-8",
      "claude-opus-4-7",
    ]);
  });
});
