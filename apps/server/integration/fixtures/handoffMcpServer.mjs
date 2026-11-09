import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "handoff-fixture", version: "1.0.0" });
server.registerTool(
  "ping",
  { description: "Check this MCP connection.", inputSchema: {} },
  async () => ({
    content: [{ type: "text", text: "pong" }],
  }),
);
await server.connect(new StdioServerTransport());
