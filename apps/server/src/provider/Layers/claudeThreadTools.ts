import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadId } from "@t3tools/contracts";
import {
  callThreadTool,
  THREAD_TOOL_DEFINITIONS,
  THREAD_TOOL_TIMEOUT_MS,
  type ThreadMcpBroker,
} from "../../mcp/threadMcpTools.ts";
import { chooseServerName } from "../../mcp/previewMcpTools.ts";
import type { ClaudePreviewServer } from "./claudeAgentBrowser.ts";

export function makeClaudeThreadMcpServer(input: {
  readonly broker: ThreadMcpBroker["Service"];
  readonly threadId: ThreadId;
  readonly existingServerNames: ReadonlySet<string>;
}): ClaudePreviewServer {
  const serverName = chooseServerName("f5_thread", input.existingServerNames);
  return {
    serverName,
    config: createSdkMcpServer({
      name: serverName,
      version: "1",
      timeout: THREAD_TOOL_TIMEOUT_MS,
      tools: THREAD_TOOL_DEFINITIONS.map((definition) =>
        tool(
          definition.name,
          definition.description,
          definition.shape,
          async (args) => {
            const result = await callThreadTool(input, definition.name, args);
            return {
              content: result.content.map((block) => ({ ...block })),
              ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
              ...(result.isError ? { isError: true } : {}),
            };
          },
          {
            annotations: { ...definition.annotations, title: definition.title },
            alwaysLoad: definition.alwaysLoad,
          },
        ),
      ),
    }),
  };
}
