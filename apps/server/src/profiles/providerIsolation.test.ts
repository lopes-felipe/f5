import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { dependencies } from "../../package.json" with { type: "json" };
import { ClaudeProviderStartOptions } from "@t3tools/contracts";
import { Schema } from "effect";
import type { ServerConfigShape } from "../config";
import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter";
import { fallbackDefaultProfile } from "./ProfileRegistryStore";
import {
  certifyProvider,
  PROFILE_CERTIFIED_PROVIDERS,
  protectProfileAdapter,
} from "./providerIsolation";
import { runProcess } from "../processRunner";

vi.mock("../processRunner", () => ({ runProcess: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
const config = {
  stateDir: process.cwd(),
  profile: { ...fallbackDefaultProfile(process.cwd()), isDefault: false },
} as unknown as ServerConfigShape;

it("requires deliberate recertification when the bundled Claude SDK changes", async () => {
  expect(PROFILE_CERTIFIED_PROVIDERS.claudeAgent).toBe(
    dependencies["@anthropic-ai/claude-agent-sdk"],
  );
  await expect(certifyProvider(config, "claudeAgent", "claude", {})).resolves.toBeUndefined();
  expect(runProcess).not.toHaveBeenCalled();
});

it("coalesces version probes and expires certification after a minute", async () => {
  vi.useFakeTimers();
  vi.mocked(runProcess).mockResolvedValue({
    stdout: "codex-cli 0.144.3",
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
  });
  await Promise.all([
    certifyProvider(config, "codex", process.execPath, {}),
    certifyProvider(config, "codex", process.execPath, {}),
  ]);
  expect(runProcess).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(60001);
  await certifyProvider(config, "codex", process.execPath, {});
  expect(runProcess).toHaveBeenCalledTimes(2);
});

it("keeps Claude's home outside per-turn options and rejects internal path overrides", async () => {
  expect("homePath" in ClaudeProviderStartOptions.fields).toBe(false);
  expect(Schema.decodeUnknownSync(ClaudeProviderStartOptions)({ homePath: "/foreign" })).toEqual(
    {},
  );
  const spawn = vi.fn(() => Effect.succeed({ text: "ok" }));
  const adapter = protectProfileAdapter(
    { provider: "claudeAgent", runOneOffPrompt: spawn } as unknown as ProviderAdapterShape<never>,
    config,
    { binaryPath: "claude", homePath: "/managed" },
  );
  await expect(
    Effect.runPromise(
      adapter.runOneOffPrompt!({
        prompt: "test",
        providerOptions: { claudeAgent: { homePath: "/foreign" } },
      } as unknown as Parameters<NonNullable<typeof adapter.runOneOffPrompt>>[0]),
    ),
  ).rejects.toThrow(/account home/);
  expect(spawn).not.toHaveBeenCalled();
});
