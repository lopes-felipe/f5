import { describe, expect, it } from "vitest";

import { isIgnorableCodexProcessStderrMessage } from "./codexStderr";

describe("codexStderr", () => {
  it("ignores opentelemetry exporter noise", () => {
    expect(
      isIgnorableCodexProcessStderrMessage(
        '2026-04-10T15:53:06.704277Z ERROR opentelemetry_sdk:  name="BatchSpanProcessor.Flush.ExportError" reason="InternalFailure(\\"reqwest::Error { kind: Status(400, None), url: \\\\\\"https://otel-mobile.doordash.com/v1/logs\\\\\\" }\\")" Failed during the export process',
      ),
    ).toBe(true);
  });

  it("ignores known rollout state-db noise", () => {
    expect(
      isIgnorableCodexProcessStderrMessage(
        "2026-02-08T04:24:20.085687Z ERROR codex_core::rollout::list: state db missing rollout path for thread 019c3b6c-46b8-7b70-ad23-82f824d161fb",
      ),
    ).toBe(true);
  });

  it("ignores the Codex cross-version model-cache TTL error", () => {
    expect(
      isIgnorableCodexProcessStderrMessage(
        "2026-08-20T14:48:43.142211Z ERROR codex_models_manager::manager: failed to renew cache TTL: missing field `supports_parallel_tool_calls` at line 4921 column 5",
      ),
    ).toBe(true);
  });

  it("ignores the ANSI-decorated Codex cross-version model-cache TTL error", () => {
    expect(
      isIgnorableCodexProcessStderrMessage(
        "2026-08-20T14:48:43.142211Z ERROR codex_models_manager::\u001b[31mmanager\u001b[0m: failed to renew cache \u001b[33mTTL\u001b[0m: missing field `\u001b[36msupports_parallel_tool_calls\u001b[0m` at line 4921 column 5",
      ),
    ).toBe(true);
  });

  it("keeps other Codex model-cache TTL failures visible", () => {
    expect(
      isIgnorableCodexProcessStderrMessage(
        "2026-08-20T14:48:43.142211Z ERROR codex_models_manager::manager: failed to renew cache TTL: permission denied",
      ),
    ).toBe(false);
  });

  it("keeps unrelated missing model-cache fields visible", () => {
    expect(
      isIgnorableCodexProcessStderrMessage(
        "2026-08-20T14:48:43.142211Z ERROR codex_models_manager::manager: failed to renew cache TTL: missing field `context_window` at line 4921 column 5",
      ),
    ).toBe(false);
  });

  it("keeps unrelated stderr visible", () => {
    expect(isIgnorableCodexProcessStderrMessage("fatal: permission denied")).toBe(false);
  });
});
