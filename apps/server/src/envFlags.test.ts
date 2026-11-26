import { Config, ConfigProvider, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { resolveAliasedBooleanEnv } from "./envFlags.ts";
import { optionalWithLegacy } from "./main.ts";
import { buildProviderChildProcessEnv } from "./providerProcessEnv.ts";

describe("envFlags and child process credential isolation", () => {
  it("optionalWithLegacy skips invalid legacy values when primary is valid, and fails on invalid primary", async () => {
    const portConfig = optionalWithLegacy(Config.port("F5_PORT"), Config.port("T3CODE_PORT"));

    const withInvalidLegacy = await Effect.runPromise(
      portConfig.parse(
        ConfigProvider.fromEnv({ env: { F5_PORT: "4123", T3CODE_PORT: "not-a-port" } }),
      ),
    );
    expect(withInvalidLegacy).toBe(4123);

    const withInvalidPrimary = await Effect.runPromiseExit(
      portConfig.parse(
        ConfigProvider.fromEnv({ env: { F5_PORT: "not-a-port", T3CODE_PORT: "4123" } }),
      ),
    );
    expect(Exit.isFailure(withInvalidPrimary)).toBe(true);

    const legacyFallback = await Effect.runPromise(
      portConfig.parse(ConfigProvider.fromEnv({ env: { T3CODE_PORT: "4123" } })),
    );
    expect(legacyFallback).toBe(4123);

    const bothMissing = await Effect.runPromise(
      portConfig.parse(ConfigProvider.fromEnv({ env: {} })),
    );
    expect(bothMissing).toBeUndefined();
  });

  it("gives primary F5_* flag precedence over legacy T3CODE_* including explicit false", () => {
    expect(
      resolveAliasedBooleanEnv("F5_LOG_PROJECTION_TIMINGS", "T3CODE_LOG_PROJECTION_TIMINGS", {
        F5_LOG_PROJECTION_TIMINGS: "0",
        T3CODE_LOG_PROJECTION_TIMINGS: "1",
      }),
    ).toEqual({ raw: "0", enabled: false });

    expect(
      resolveAliasedBooleanEnv("F5_LOG_PROJECTION_TIMINGS", "T3CODE_LOG_PROJECTION_TIMINGS", {
        T3CODE_LOG_PROJECTION_TIMINGS: "1",
      }),
    ).toEqual({ raw: "1", enabled: true });

    expect(
      resolveAliasedBooleanEnv("F5_LOG_PROJECTION_TIMINGS", "T3CODE_LOG_PROJECTION_TIMINGS", {
        F5_LOG_PROJECTION_TIMINGS: "true",
      }),
    ).toEqual({ raw: "true", enabled: true });
  });

  it("strips both F5_AUTH_TOKEN and T3CODE_AUTH_TOKEN and F5 server vars from provider children", () => {
    const childEnv = buildProviderChildProcessEnv(
      {
        PATH: "/usr/bin",
        F5_AUTH_TOKEN: "secret-f5",
        T3CODE_AUTH_TOKEN: "secret-legacy",
        F5_PORT: "3773",
        F5_HOST: "0.0.0.0",
        F5_MODE: "web",
        F5_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "1",
        USER_CUSTOM_VAR: "keep",
      },
      {
        F5_AUTH_TOKEN: "override-secret-f5",
        T3CODE_AUTH_TOKEN: "override-secret-legacy",
        f5_auth_token: "override-secret-lower",
        CUSTOM_OVERRIDE: "ok",
      },
    );

    expect(childEnv.F5_AUTH_TOKEN).toBeUndefined();
    expect(childEnv.T3CODE_AUTH_TOKEN).toBeUndefined();
    expect(childEnv.f5_auth_token).toBeUndefined();
    expect(childEnv.F5_PORT).toBeUndefined();
    expect(childEnv.F5_HOST).toBeUndefined();
    expect(childEnv.F5_MODE).toBeUndefined();
    expect(childEnv.F5_AUTO_BOOTSTRAP_PROJECT_FROM_CWD).toBeUndefined();
    expect(childEnv.USER_CUSTOM_VAR).toBe("keep");
    expect(childEnv.CUSTOM_OVERRIDE).toBe("ok");
  });
});
