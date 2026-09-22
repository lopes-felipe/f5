import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { dependencies } from "../../package.json" with { type: "json" };
import { ClaudeProviderStartOptions } from "@t3tools/contracts";
import { Schema } from "effect";
import type { ServerConfigShape } from "../config";
import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter";
import { fallbackDefaultProfile } from "./ProfileRegistryStore";
import {
  codexIsolationCompatibility,
  validateProviderCompatibility,
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
  await expect(
    validateProviderCompatibility(config, "claudeAgent", "claude", {}),
  ).resolves.toBeUndefined();
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
    validateProviderCompatibility(config, "codex", process.execPath, {}),
    validateProviderCompatibility(config, "codex", process.execPath, {}),
  ]);
  expect(runProcess).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(60001);
  await validateProviderCompatibility(config, "codex", process.execPath, {});
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

it.each(["0.147.0", "0.148.0", "1.0.0", "0.147.0-alpha.1"])(
  "allows forward-compatible Codex %s",
  (version) => {
    expect(codexIsolationCompatibility(version)).toEqual({
      supported: true,
      message: expect.stringContaining(`Codex ${version} differs from this build`),
    });
  },
);
it("accepts the baseline without a notice", () => {
  expect(codexIsolationCompatibility("0.144.3")).toEqual({ supported: true });
});
it.each(["0.144.2", "0.144.3-alpha.1", "unknown", null])(
  "rejects below-floor or unknown versions: %s",
  (version) => {
    expect(codexIsolationCompatibility(version).supported).toBe(false);
  },
);
it("accepts a newer executable, caches probes, and rechecks an in-place update", async () => {
  vi.useFakeTimers();
  const environment = { CODEX_HOME: "/managed/newer", F5_PROFILE_ISOLATED: "1" };
  vi.mocked(runProcess).mockResolvedValue({
    stdout: "codex-cli 0.147.0",
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
  });
  await validateProviderCompatibility(config, "codex", process.execPath, environment);
  expect(runProcess).toHaveBeenCalledWith(
    process.execPath,
    ["--version"],
    expect.objectContaining({ env: environment }),
  );
  vi.mocked(runProcess).mockResolvedValue({
    stdout: "codex-cli 0.140.0",
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
  });
  vi.advanceTimersByTime(60001);
  await expect(
    validateProviderCompatibility(config, "codex", process.execPath, environment),
  ).rejects.toThrow(/minimum/);
});
it.each([
  {
    stdout: "garbage",
    stderr: "",
    code: 0,
    timedOut: false,
    expected: /determine the Codex version/,
  },
  {
    stdout: "codex-cli 0.147.0",
    stderr: "broken executable",
    code: 1,
    timedOut: false,
    expected: /broken executable/,
  },
  { stdout: "", stderr: "", code: null, timedOut: true, expected: /timed out/ },
])("preserves actionable probe failures: $expected", async (result) => {
  vi.mocked(runProcess).mockResolvedValue({ ...result, signal: null });
  await expect(
    validateProviderCompatibility(config, "codex", process.execPath, {
      TEST_CASE: String(result.expected),
    }),
  ).rejects.toThrow(result.expected);
});
it("preserves missing-executable failures and never probes Default", async () => {
  vi.mocked(runProcess).mockRejectedValue(new Error("ENOENT: codex missing"));
  await expect(
    validateProviderCompatibility(config, "codex", process.execPath, { TEST_CASE: "missing" }),
  ).rejects.toThrow(/ENOENT/);
  vi.mocked(runProcess).mockClear();
  await validateProviderCompatibility(
    { ...config, profile: { ...config.profile!, isDefault: true } },
    "codex",
    "missing",
    {},
  );
  expect(runProcess).not.toHaveBeenCalled();
});

it("does not cache a failed probe after the executable is repaired", async () => {
  const environment = { TEST_CASE: "repaired" };
  vi.mocked(runProcess).mockRejectedValueOnce(new Error("executable unavailable"));
  await expect(
    validateProviderCompatibility(config, "codex", process.execPath, environment),
  ).rejects.toThrow(/unavailable/);
  vi.mocked(runProcess).mockResolvedValueOnce({
    stdout: "",
    stderr: "codex-cli 0.147.0",
    code: 0,
    signal: null,
    timedOut: false,
  });
  await expect(
    validateProviderCompatibility(config, "codex", process.execPath, environment),
  ).resolves.toBeUndefined();
  expect(runProcess).toHaveBeenCalledTimes(2);
});
