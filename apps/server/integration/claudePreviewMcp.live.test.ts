import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ThreadId, type PreviewAutomationRequest } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makePreviewAutomationBroker } from "../src/mcp/PreviewAutomationBroker.ts";
import { buildClaudeQueryEnv } from "../src/provider/Layers/ClaudeAdapter.ts";
import { makeClaudePreviewMcpServer } from "../src/provider/Layers/claudeAgentBrowser.ts";
import { createControllableAsyncIterable } from "../src/provider/Layers/ClaudeSdk.testUtils.ts";

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// Explicit opt-in: uses the current Claude account and consumes its quota.
describe.skipIf(process.env.F5_CLAUDE_LIVE_TEST !== "1")(
  "Claude in-process F5 preview tools",
  () => {
    it("lists and calls preview tools in-process and receives a real image block", async () => {
      const threadId = ThreadId.makeUnsafe("thread-live-preview");
      const broker = makePreviewAutomationBroker();
      const seen: PreviewAutomationRequest[] = [];
      await Effect.runPromise(
        broker.reportOwner(
          {
            clientId: "live-owner",
            threadId,
            tabId: "tab-live" as never,
            visible: true,
            supportsAutomation: true,
            capabilities: ["automation", "screenshot"],
            focusedAt: new Date().toISOString(),
          },
          {
            clientId: "live-owner",
            send: (request) =>
              Effect.sync(() => {
                seen.push(request);
                const result =
                  request.operation === "snapshot"
                    ? {
                        url: "http://localhost:5173/",
                        title: "F5 live preview",
                        loading: false,
                        visibleText: "Sentinel page F5-LIVE-7731",
                        interactiveElements: [],
                        accessibilityTree: null,
                        consoleEntries: [],
                        networkEntries: [],
                        actionTimeline: [],
                        screenshot: {
                          mimeType: "image/png",
                          data: ONE_PIXEL_PNG,
                          width: 1,
                          height: 1,
                        },
                      }
                    : {
                        available: true,
                        visible: true,
                        tabId: "tab-live",
                        url: "http://localhost:5173/",
                        title: "F5 live preview",
                        loading: false,
                      };
                void Effect.runPromise(
                  broker.respond(
                    {
                      requestId: request.requestId,
                      clientId: request.clientId,
                      connectionId: request.connectionId,
                      ok: true,
                      result,
                    },
                    new Set(["live-owner"]),
                  ),
                );
                return true;
              }),
          },
        ),
      );
      const preview = makeClaudePreviewMcpServer({
        broker,
        threadId,
        existingServerNames: new Set(),
      });
      const cwd = mkdtempSync(join(tmpdir(), "f5-claude-preview-live-"));
      const input = createControllableAsyncIterable<SDKUserMessage>();
      const q = query({
        prompt: input.iterable,
        options: {
          cwd,
          model: "claude-fable-5-1",
          persistSession: false,
          settingSources: [],
          env: buildClaudeQueryEnv({ subagentModel: "inherit" }, process.env),
          maxTurns: 8,
          mcpServers: { [preview.serverName]: preview.config },
          extraArgs: { "no-chrome": null },
          canUseTool: async (name, toolInput, options) =>
            name.startsWith(`mcp__${preview.serverName}__`) && options.mcpServer?.source === "sdk"
              ? { behavior: "allow", updatedInput: toolInput }
              : name === "ToolSearch"
                ? { behavior: "allow", updatedInput: toolInput }
                : { behavior: "deny", message: "Only F5 preview tools are allowed here." },
        },
      });
      const deadline = setTimeout(() => q.close(), 110_000);
      try {
        await q.initializationResult();
        const statuses = await q.mcpServerStatus();
        expect(statuses.find((status) => status.name === preview.serverName)?.source).toBe("sdk");
        input.push({
          type: "user",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content:
              "Call the preview_status tool, then the preview_snapshot tool. Reply with the sentinel code from the page's visible text and nothing else.",
          },
        });
        const messages: SDKMessage[] = [];
        for (;;) {
          const next = await q.next();
          if (next.done) break;
          messages.push(next.value);
          if (next.value.type === "result") break;
        }
        const toolResults = messages.flatMap((message) =>
          message.type === "user" && Array.isArray(message.message.content)
            ? message.message.content.filter((block) => block.type === "tool_result")
            : [],
        );
        expect(JSON.stringify(toolResults)).toContain('"type":"image"');
        expect(seen.map((request) => request.operation)).toEqual(
          expect.arrayContaining(["status", "snapshot"]),
        );
        const result = messages.at(-1);
        expect(result?.type === "result" && result.subtype === "success").toBe(true);
        expect(JSON.stringify(result)).toContain("F5-LIVE-7731");
      } finally {
        clearTimeout(deadline);
        q.close();
        input.end();
        await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }, 120_000);
  },
);
