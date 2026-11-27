// MCP hub test fixture: a small stdio server built on the SDK.
// argv[2] (optional): a file that receives this process's cwd and roots answer.
import { writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const report = process.argv[2];
let tools = [
  {
    name: "echo",
    description: "Echo text",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
  { name: "slow", description: "Reports progress", inputSchema: { type: "object" } },
  { name: "hidden", description: "Filtered by F5", inputSchema: { type: "object" } },
  {
    name: "add_tool",
    description: "Adds a tool and announces it",
    inputSchema: { type: "object" },
  },
  { name: "ask", description: "Asks the user a question", inputSchema: { type: "object" } },
  { name: "ask_url", description: "Sends the user to a page", inputSchema: { type: "object" } },
  {
    name: "wait",
    description: "Answers after a delay",
    inputSchema: { type: "object", properties: { ms: { type: "number" } } },
  },
];
process.stderr.write(`hub fixture started token=${process.env.HUB_FIXTURE_TOKEN ?? "none"}\n`);

const server = new Server(
  { name: "hub-fixture", version: "2.0.0" },
  { capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;
  if (name === "echo") return { content: [{ type: "text", text: `echo:${args?.text ?? ""}` }] };
  if (name === "slow") {
    const token = request.params._meta?.progressToken;
    for (let step = 1; step <= 3; step++) {
      if (token !== undefined)
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken: token, progress: step, total: 3 },
        });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return { content: [{ type: "text", text: "done" }] };
  }
  if (name === "ask") {
    const answer = await server.elicitInput({
      message: "Pick a color",
      requestedSchema: { type: "object", properties: { color: { type: "string" } } },
    });
    return {
      content: [{ type: "text", text: `${answer.action}:${answer.content?.color ?? ""}` }],
    };
  }
  if (name === "ask_url") {
    const answer = await server.elicitInput({
      mode: "url",
      message: "Finish on the page",
      url: "https://example.test/finish",
      elicitationId: "fixture-elicitation",
    });
    if (answer.action === "accept")
      await server.createElicitationCompletionNotifier("fixture-elicitation")();
    return { content: [{ type: "text", text: `url:${answer.action}` }] };
  }
  if (name === "wait") {
    await new Promise((resolve) => setTimeout(resolve, Number(args?.ms ?? 100)));
    return { content: [{ type: "text", text: "waited" }] };
  }
  if (name === "add_tool") {
    tools = [...tools, { name: "added", inputSchema: { type: "object" } }];
    await server.sendToolListChanged();
    return { content: [{ type: "text", text: "added" }] };
  }
  return { content: [{ type: "text", text: `called ${name}` }] };
});
server.setRequestHandler(ListResourcesRequestSchema, () => ({
  resources: [{ uri: "fixture://readme", name: "Readme", mimeType: "text/plain" }],
}));
server.setRequestHandler(ReadResourceRequestSchema, (request) => ({
  contents: [{ uri: request.params.uri, mimeType: "text/plain", text: "fixture readme" }],
}));
server.setRequestHandler(ListPromptsRequestSchema, () => ({
  prompts: [{ name: "greet", arguments: [{ name: "who", required: true }] }],
}));
server.setRequestHandler(GetPromptRequestSchema, (request) => ({
  messages: [
    {
      role: "user",
      content: { type: "text", text: `Hello ${request.params.arguments?.who ?? "?"}` },
    },
  ],
}));
server.oninitialized = async () => {
  if (!report) return;
  let roots = [];
  try {
    roots = (await server.listRoots()).roots;
  } catch {}
  writeFileSync(report, JSON.stringify({ cwd: process.cwd(), roots }));
};
await server.connect(new StdioServerTransport());
