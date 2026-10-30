import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadId } from "@t3tools/contracts";
import {
  callThreadTool,
  threadToolDefinitions,
  THREAD_TOOL_TIMEOUT_MS,
  type ThreadMcpBroker,
  type ThreadToolAccess,
} from "../../mcp/threadMcpTools.ts";
import type { McpToolProvenance } from "../claudeMandatoryPolicy.ts";
import { chooseServerName } from "../../mcp/previewMcpTools.ts";
import type { ClaudePreviewServer } from "./claudeAgentBrowser.ts";

export function makeClaudeThreadMcpServer(input: {
  readonly broker: ThreadMcpBroker["Service"];
  readonly threadId: ThreadId;
  readonly existingServerNames: ReadonlySet<string>;
  /** Read-only workflow turns get only the tools that read. Defaults to full. */
  readonly access?: ThreadToolAccess;
}): ClaudePreviewServer {
  const serverName = chooseServerName("f5_thread", input.existingServerNames);
  return {
    serverName,
    config: createSdkMcpServer({
      name: serverName,
      version: "1",
      timeout: THREAD_TOOL_TIMEOUT_MS,
      tools: threadToolDefinitions(input.access ?? "full").map((definition) =>
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

/**
 * True only for F5's own `thread_read` on the thread server this session installed. Another
 * server with a look-alike name or a non-SDK source is not F5's.
 */
export function isF5ThreadReadTool(
  toolName: string,
  mcpServer: McpToolProvenance | undefined,
  serverName: string,
): boolean {
  if (toolName !== `mcp__${serverName}__thread_read`) return false;
  // Without provenance only the name identifies the server. `chooseServerName` picked a name no
  // configured server uses, so the name alone still points at F5's server.
  return mcpServer === undefined || (mcpServer.source === "sdk" && mcpServer.name === serverName);
}
