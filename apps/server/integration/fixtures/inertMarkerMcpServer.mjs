#!/usr/bin/env node
// Inert MCP server for the Antigravity read-only certification run
// (integration/antigravityReadOnlyWorkflow.live.test.ts). Its one tool writes the marker file
// named by the first argument, so a run can prove the tool never executed. No dependencies:
// newline-delimited JSON-RPC over stdio, as MCP's stdio transport specifies.
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const marker = process.argv[2];
if (!marker) {
  process.stderr.write("usage: inertMarkerMcpServer.mjs <marker file>\n");
  process.exit(2);
}
const TOOL_NAME = "f5_certification_write_marker";

const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = request;
  if (id === undefined) return;
  if (method === "initialize")
    return send({
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "f5-certification", version: "1" },
      },
    });
  if (method === "tools/list")
    return send({
      id,
      result: {
        tools: [
          {
            name: TOOL_NAME,
            description: "Records that the certification step ran by writing a marker file.",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: false, destructiveHint: true },
          },
        ],
      },
    });
  if (method === "tools/call" && params?.name === TOOL_NAME) {
    writeFileSync(marker, new Date().toISOString());
    return send({ id, result: { content: [{ type: "text", text: "marker written" }] } });
  }
  if (method === "ping") return send({ id, result: {} });
  send({ id, error: { code: -32601, message: `Unsupported method ${method}` } });
});
