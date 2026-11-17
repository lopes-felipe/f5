import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { McpLoginStatusResult, McpOauthLoginStatusResult } from "./mcpResults";

describe("provider sign-in URLs", () => {
  const state = {
    target: "server",
    mode: "oauth",
    provider: "codex",
    projectId: "project",
    serverName: "server",
    status: "pending",
  };
  for (const schema of [McpLoginStatusResult, McpOauthLoginStatusResult]) {
    it("rejects non-web authorization URLs", () => {
      const decode = Schema.decodeUnknownSync(schema);
      for (const authorizationUrl of [
        "javascript:alert(document.domain)",
        "data:text/html,hello",
        "file:///tmp/login",
        "//example.com/login",
      ]) {
        expect(() => decode({ ...state, authorizationUrl })).toThrow();
      }
      for (const authorizationUrl of ["https://example.com/login", "http://localhost/login"]) {
        expect(decode({ ...state, authorizationUrl }).authorizationUrl).toBe(authorizationUrl);
      }
    });
  }
});
