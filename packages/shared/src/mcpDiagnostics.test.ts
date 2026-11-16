import { describe, expect, it } from "vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import {
  createMcpDiagnosticsSanitizer,
  isMcpCredentialKey,
  sanitizeMcpReconnectResult,
} from "./mcpDiagnostics";

describe("MCP diagnostics redaction", () => {
  const safe = createMcpDiagnosticsSanitizer({
    docs: {
      type: "http",
      url: "https://example.test",
      headers: { Authorization: "header-value-secret" },
    },
    local: { type: "stdio", command: "node", env: { LONG: "env-value-secret", SHORT: "abc" } },
  });
  it("scrubs configured values without corrupting text with short values", () => {
    expect(safe.text("abc env-value-secret header-value-secret")).toBe("abc [redacted] [redacted]");
  });
  it("strips URL credentials, query strings, and fragments", () => {
    expect(safe.text("Error at https://user:password@example.test/path?token=bad#frag")).toBe(
      "Error at https://example.test/path",
    );
  });
  it("strips credentials and query strings from non-HTTP endpoint URLs", () => {
    expect(safe.text("postgres://user:password@database.test/db?key=secret#fragment")).toBe(
      "postgres://database.test/db",
    );
  });
  it("redacts credential fields and header names", () => {
    expect(
      safe.json({
        Authorization: "Bearer abc",
        "x-api-key": "key",
        "x-access-token": "token",
        clientSecret: "secret",
        authorizationUrl: "https://auth.test/callback",
      }),
    ).toEqual({
      Authorization: "[redacted]",
      "x-api-key": "[redacted]",
      "x-access-token": "[redacted]",
      clientSecret: "[redacted]",
      authorizationUrl: "[redacted]",
    });
    expect(safe.text("Authorization: Bearer abcdefgh")).toBe("Authorization: [redacted]");
  });
  it.each([
    "token",
    "api_key",
    "apiKey",
    "access_token",
    "accessToken",
    "password",
    "cookie",
    "clientSecret",
    "x-api-key",
  ])("redacts %s in JSON and unstructured assignments", (key) => {
    expect(isMcpCredentialKey(key)).toBe(true);
    expect(safe.json({ [key]: "sensitive" })).toEqual({ [key]: "[redacted]" });
    expect(safe.text(`state=failed ${key}=sensitive`)).not.toContain("sensitive");
    expect(safe.text(`${key}: "sensitive with spaces"`)).not.toContain("sensitive");
  });
  it("scrubs bare bearer tokens and does not classify ordinary key suffixes", () => {
    expect(safe.text("Authentication failed: Bearer xyz_123")).not.toContain("xyz_123");
    expect(isMcpCredentialKey("monkey")).toBe(false);
    expect(safe.text("Authorization: Basic encoded-user-password")).toBe(
      "Authorization: [redacted]",
    );
    expect(safe.text("Cookie: session=private; other=private-too")).toBe("Cookie: [redacted]");
  });
  it("uses account bearer values for reconnect failures and session errors", () => {
    const result = sanitizeMcpReconnectResult(
      {
        settingsConnectionReloaded: false,
        sessionsMatched: 0,
        sessionsReconnected: 0,
        failures: [{ message: "account-bearer-secret" }],
        sessions: [
          {
            threadId: ThreadId.make("thread"),
            instanceId: ProviderInstanceId.make("account"),
            generation: 1,
            requestedVersion: "saved",
            attemptedVersion: "saved",
            disposition: "failed",
            result: {
              converged: false,
              restartRequired: false,
              errors: [{ message: "account-bearer-secret" }],
              servers: [
                { name: "docs", status: "failed", owned: true, error: "account-bearer-secret" },
              ],
            },
          },
        ],
      },
      {},
      ["account-bearer-secret"],
    );
    expect(JSON.stringify(result)).not.toContain("account-bearer-secret");
  });
});
