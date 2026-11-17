import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { claudeCredentialExpiryWarning, claudeStartupFailureMessage } from "./ClaudeAdapter.ts";

describe("claudeStartupFailureMessage: config_file_invalid", () => {
  const invalid = (file: unknown) =>
    ({
      type: "result",
      subtype: "error_during_execution",
      errors: ["text naming /elsewhere.json"],
      startup_failure_reason: "config_file_invalid",
      invalid_config_file: file,
    }) as unknown as SDKResultMessage;

  it("names the file and its backup from structured fields only", () => {
    expect(
      claudeStartupFailureMessage(
        invalid({
          path: "/home/u/.claude.json",
          is_global: true,
          backup_searched: true,
          backup_path: "/home/u/.claude/backups/.claude.json.backup.1",
        }),
      ),
    ).toBe(
      "Claude's config file /home/u/.claude.json is not valid JSON. Restore or repair it from /home/u/.claude/backups/.claude.json.backup.1.",
    );
    expect(
      claudeStartupFailureMessage(
        invalid({ path: "/repo/.claude/settings.json", is_global: false, backup_searched: false }),
      ),
    ).toBe(
      "Claude's config file /repo/.claude/settings.json is not valid JSON. Repair it; Claude refuses to start until then.",
    );
  });

  it("keeps Claude's own message without a structured path", () => {
    expect(claudeStartupFailureMessage(invalid(undefined))).toBeUndefined();
    expect(claudeStartupFailureMessage(invalid({ path: " " }))).toBeUndefined();
  });
});

describe("claudeCredentialExpiryWarning", () => {
  const now = Date.parse("2026-11-17T12:00:00Z");
  const format = (date: Date) => date.toISOString().slice(0, 10);

  it("stays silent until seven days remain", () => {
    expect(claudeCredentialExpiryWarning("2026-11-25T12:00:01Z", now, format)).toBeUndefined();
    expect(claudeCredentialExpiryWarning("2026-11-24T12:00:00Z", now, format)).toBe(
      "This Claude login ends around 2026-11-24; sign in again before then.",
    );
  });

  it("treats a past date as a probably ended login", () => {
    expect(claudeCredentialExpiryWarning("2026-11-17T12:00:00Z", now, format)).toBe(
      "This Claude login has probably ended; sign in again.",
    );
  });

  it("ignores absent or malformed values", () => {
    expect(claudeCredentialExpiryWarning(undefined, now, format)).toBeUndefined();
    expect(claudeCredentialExpiryWarning("soon", now, format)).toBeUndefined();
  });
});
