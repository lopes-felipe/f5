import { describe, expect, it } from "vitest";

import { buildProviderChildProcessEnv } from "./providerProcessEnv";

describe("buildProviderChildProcessEnv", () => {
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
