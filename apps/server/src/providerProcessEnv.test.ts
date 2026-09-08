import { describe, expect, it } from "vitest";

import * as Path from "node:path";
import { fallbackDefaultProfile } from "./profiles/ProfileRegistryStore";
import {
  buildAccountExecutionEnvironment,
  assertAccountEnvironmentOverrides,
  buildProviderChildProcessEnv,
} from "./providerProcessEnv";

describe("buildProviderChildProcessEnv", () => {
  it("replaces differently-cased inherited variables on Windows", () => {
    const env = buildProviderChildProcessEnv(
      { ANTHROPIC_API_KEY: "ambient" },
      { anthropic_api_key: "instance" },
    );
    expect(env.anthropic_api_key).toBe("instance");
    expect(env.ANTHROPIC_API_KEY).toBe(process.platform === "win32" ? undefined : "ambient");
  });
  it("strips inherited OpenTelemetry variables", () => {
    const env = buildProviderChildProcessEnv({
      PATH: "/usr/bin",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel-mobile.doordash.com",
      OTEL_SERVICE_NAME: "desktop-shell",
      HOME: "/Users/tester",
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/tester",
    });
  });

  it("treats env keys case-insensitively and applies overrides", () => {
    const env = buildProviderChildProcessEnv(
      {
        PATH: "/usr/bin",
        otel_exporter_otlp_logs_endpoint: "https://example.com/v1/logs",
        CLAUDE_CODE_SUBAGENT_MODEL: "haiku",
      },
      {
        CLAUDE_CODE_SUBAGENT_MODEL: undefined,
        CODEX_HOME: "/tmp/codex-home",
      },
    );

    expect(env).toEqual({
      PATH: "/usr/bin",
      CODEX_HOME: "/tmp/codex-home",
    });
  });
});

describe("profile account execution", () => {
  const stateDir = Path.resolve("profile-test-state");
  const profile = { ...fallbackDefaultProfile(stateDir), isDefault: false };
  const baseEnv = {
    PATH: "tools",
    ANTHROPIC_API_KEY: "ambient",
    GH_TOKEN: "machine",
    CODEX_HOME: "machine-home",
    HOME: "machine-home",
    USERPROFILE: "machine-home",
    OTEL_EXPORTER_OTLP_ENDPOINT: "ambient-telemetry",
  };
  it("strips ambient credentials, retains PATH and supplies managed storage", () => {
    const env = buildAccountExecutionEnvironment({
      purpose: "provider",
      stateDir,
      profile,
      baseEnv,
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(env.PATH).toBe("tools");
    expect(env.CODEX_HOME).toBe(Path.join(stateDir, "provider-homes", "codex"));
    expect(env.HOME).toBe(env.USERPROFILE);
    expect(env.F5_PROFILE_ISOLATED).toBe("1");
  });
  it("lets deliberate instance API credentials win and preserves Default inheritance", () => {
    expect(
      buildAccountExecutionEnvironment({
        purpose: "provider",
        stateDir,
        profile,
        baseEnv,
        instance: [{ name: "ANTHROPIC_API_KEY", value: "work", sensitive: true }],
      }).ANTHROPIC_API_KEY,
    ).toBe("work");
    const env = buildAccountExecutionEnvironment({
      purpose: "provider",
      stateDir,
      profile: { ...profile, isDefault: true },
      baseEnv,
    });
    expect(env.ANTHROPIC_API_KEY).toBe("ambient");
    expect(env.CODEX_HOME).toBe("machine-home");
    expect(env.F5_PROFILE_ISOLATED).toBeUndefined();
  });
  it.each([
    "home",
    "UsErPrOfIlE",
    "XDG_CONFIG_HOME",
    "GIT_CONFIG_COUNT",
    "SSH_AUTH_SOCK",
    "F5_PROFILE",
  ])("rejects reserved override %s", (key) => {
    expect(() => assertAccountEnvironmentOverrides({ [key]: "escape" })).toThrow(/reserved/);
  });
});
