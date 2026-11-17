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
      "Claude's config file /home/u/.claude.json is not valid JSON, and Claude refuses to start until it is fixed. A backup is at /home/u/.claude/backups/.claude.json.backup.1; check that it is valid JSON before restoring it.",
    );
    expect(
      claudeStartupFailureMessage(
        invalid({ path: "/home/u/.claude.json", is_global: true, backup_searched: true }),
      ),
    ).toBe(
      "Claude's config file /home/u/.claude.json is not valid JSON, and Claude refuses to start until it is fixed. Claude found no backup, so repair the file by hand.",
    );
    expect(
      claudeStartupFailureMessage(
        invalid({ path: "/repo/.claude/settings.json", is_global: false, backup_searched: false }),
      ),
    ).toBe(
      "Claude's config file /repo/.claude/settings.json is not valid JSON, and Claude refuses to start until it is fixed. Repair it by hand.",
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

  it("stays silent until seven days remain before the earliest end, 3 days early", () => {
    expect(claudeCredentialExpiryWarning("2026-11-27T12:00:01Z", now, format)).toBeUndefined();
    expect(claudeCredentialExpiryWarning("2026-11-27T12:00:00Z", now, format)).toBe(
      "This Claude login may end as early as 2026-11-24; sign in again before then.",
    );
  });

  it("says the login may end at any time once the earliest end has passed", () => {
    expect(claudeCredentialExpiryWarning("2026-11-20T12:00:00Z", now, format)).toBe(
      "This Claude login may end at any time; sign in again.",
    );
    expect(claudeCredentialExpiryWarning("2026-11-10T12:00:00Z", now, format)).toBe(
      "This Claude login may end at any time; sign in again.",
    );
  });

  it("formats the default date in UTC", () => {
    expect(claudeCredentialExpiryWarning("2026-11-27T01:00:00Z", now)).toBe(
      "This Claude login may end as early as Nov 24, 2026 (UTC); sign in again before then.",
    );
  });

  it("ignores absent or malformed values", () => {
    expect(claudeCredentialExpiryWarning(undefined, now, format)).toBeUndefined();
    expect(claudeCredentialExpiryWarning("soon", now, format)).toBeUndefined();
  });
});
