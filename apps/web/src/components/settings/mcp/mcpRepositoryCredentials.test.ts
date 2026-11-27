import { describe, expect, it } from "vitest";

import { mcpRepositoryCredentialUses } from "./mcpRepositoryCredentials";

describe("mcpRepositoryCredentialUses", () => {
  it("names the bearer variable and the host it is sent to", () => {
    expect(
      mcpRepositoryCredentialUses({
        type: "http",
        url: "https://mcp.example/${env:TENANT}",
        headers: { "X-Key": "key ${env:AWS_SECRET_ACCESS_KEY:-none}" },
        bearerTokenEnvVar: "GITHUB_TOKEN",
      }),
    ).toEqual([
      "$TENANT → the URL (mcp.example)",
      "$AWS_SECRET_ACCESS_KEY → header X-Key, sent to mcp.example",
      "$GITHUB_TOKEN → Authorization: Bearer, sent to mcp.example",
    ]);
  });

  it("finds references in a command, its arguments and its environment", () => {
    expect(
      mcpRepositoryCredentialUses({
        type: "stdio",
        command: "node",
        args: ["server.js", "--token=${env:API_TOKEN}"],
        env: { HOME_DIR: "${env:HOME}", PLAIN: "value" },
      }),
    ).toEqual(["$API_TOKEN → argument 2", "$HOME → environment variable HOME_DIR"]);
  });

  it("is empty for a definition that sends nothing from the environment", () => {
    expect(mcpRepositoryCredentialUses({ type: "http", url: "https://mcp.example" })).toEqual([]);
  });
});
