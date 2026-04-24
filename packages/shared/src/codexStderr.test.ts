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

  it("keeps unrelated stderr visible", () => {
    expect(isIgnorableCodexProcessStderrMessage("fatal: permission denied")).toBe(false);
  });
});
