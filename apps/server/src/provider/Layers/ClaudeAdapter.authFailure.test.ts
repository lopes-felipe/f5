import { describe, expect, it } from "vitest";

import { isClaudeApiKeyFailureText, isClaudeAuthFailureText } from "./ClaudeAdapter.ts";

describe("Claude expired-login classification", () => {
  it.each([
    "Failed to authenticate: OAuth session expired and could not be refreshed",
    "OAuth token has expired. Please run /login",
    "Not signed in. Run /login to continue.",
  ])("recognizes %s", (text) => {
    expect(isClaudeAuthFailureText(text)).toBe(true);
  });

  it.each([
    // Other tools and gateways use the same words; they don't need a Claude sign-in.
    "gh: not logged in to any hosts",
    "MCP server linear: 401 Unauthorized",
    "Gateway returned unauthorized",
    // A rejected configured key needs a settings change, not a browser login.
    "Invalid API key · Fix external API key",
    "invalid x-api-key",
    "Usage limit reached. OAuth token has expired",
  ])("ignores %s", (text) => {
    expect(isClaudeAuthFailureText(text)).toBe(false);
  });

  it("recognizes rejected configured API keys separately", () => {
    expect(isClaudeApiKeyFailureText("Invalid API key · Fix external API key")).toBe(true);
    expect(isClaudeApiKeyFailureText("OAuth session expired")).toBe(false);
  });
});
