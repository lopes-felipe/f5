import { expect, it } from "vitest";
import { Schema } from "effect";
import { McpInspectServerRequest, McpReconnectServerRequest } from "./mcp";

it("resolves inspector and reconnect providers from account-only requests", () => {
  const request = { projectId: "project", instanceId: "account", serverName: "docs" };
  expect(Schema.decodeUnknownSync(McpInspectServerRequest)(request)).toEqual(request);
  expect(Schema.decodeUnknownSync(McpReconnectServerRequest)(request)).toEqual(request);
});
