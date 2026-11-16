import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { computerHostFixture } from "./computer/hostFixture";
import { buildClaudeQueryEnv } from "../src/provider/Layers/ClaudeAdapter.ts";
import { makeClaudeComputerMcpServer } from "../src/provider/Layers/claudeAgentBrowser.ts";
import { createControllableAsyncIterable } from "../src/provider/Layers/ClaudeSdk.testUtils.ts";

// Explicit opt-in: uses the current Claude account and consumes its quota.
describe.skipIf(process.env.F5_CLAUDE_LIVE_TEST !== "1")(
  "Claude in-process F5 computer transport",
  () => {
    it("discovers computer tools, obtains fixture consent, receives an image and dispatches an action", async () => {
      const threadId = ThreadId.makeUnsafe("thread-live-computer");
      const fixture = await computerHostFixture();
      const computer = makeClaudeComputerMcpServer({
        broker: fixture.broker,
        threadId,
        existingServerNames: new Set(),
      });
      const cwd = mkdtempSync(join(tmpdir(), "f5-claude-computer-live-"));
      const input = createControllableAsyncIterable<SDKUserMessage>();
      const q = query({
        prompt: input.iterable,
        options: {
          cwd,
          model: process.env.F5_CLAUDE_COMPUTER_MODEL ?? "claude-fable-5-1",
          persistSession: false,
          settingSources: [],
          // A test launched from an agent terminal inherits its isolated HOME.
          // macOS needs the real home and login name for its keychain lookup.
          // CLAUDE_CONFIG_DIR still selects this profile's isolated credential.
          env: buildClaudeQueryEnv(
            { subagentModel: "inherit" },
            process.platform === "darwin" && process.env.CLAUDE_CONFIG_DIR
              ? {
                  ...process.env,
                  HOME: userInfo().homedir,
                  USER: process.env.USER ?? userInfo().username,
                }
              : process.env,
          ),
          maxTurns: 8,
          mcpServers: { [computer.serverName]: computer.config },
          extraArgs: { "no-chrome": null },
          canUseTool: async (name, toolInput, options) =>
            name.startsWith(`mcp__${computer.serverName}__`) && options.mcpServer?.source === "sdk"
              ? { behavior: "allow", updatedInput: toolInput }
              : name === "ToolSearch"
                ? { behavior: "allow", updatedInput: toolInput }
                : {
                    behavior: "deny",
                    message: "Only F5 computer transport fixture tools are allowed here.",
                  },
        },
      });
      const deadline = setTimeout(() => q.close(), 110_000);
      try {
        await q.initializationResult();
        const statuses = await q.mcpServerStatus();
        expect(statuses.find((status) => status.name === computer.serverName)?.source).toBe("sdk");
        input.push({
          type: "user",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content:
              "This is a simulated transport fixture, not a real desktop. Call computer_status, computer_request_access for F5 transport test app with reason Protocol test, computer_screenshot, then computer_click at x=0 y=0. Finish with READY. Do not use other tools.",
          },
        });
        const messages: SDKMessage[] = [];
        for (;;) {
          const next = await q.next();
          if (next.done) break;
          messages.push(next.value);
          if (next.value.type === "result") break;
        }
        const result = messages.at(-1);
        if (result?.type === "result" && result.subtype === "success")
          expect(
            result.result,
            "The test process could not access this profile's Claude credentials.",
          ).not.toContain("Not logged in");
        expect(
          result?.type === "result" && result.subtype === "success",
          result?.type === "result" && "errors" in result
            ? result.errors.join("\n")
            : "Claude did not complete the transport turn.",
        ).toBe(true);
        const toolResults = messages.flatMap((message) =>
          message.type === "user" && Array.isArray(message.message.content)
            ? message.message.content.filter((block) => block.type === "tool_result")
            : [],
        );
        expect(JSON.stringify(toolResults)).toContain('"type":"image"');
        expect(fixture.seen.map((request) => request.op)).toEqual(
          expect.arrayContaining(["resolveApps", "screenshot", "click"]),
        );
        expect(fixture.consentCount()).toBeGreaterThan(0);
        fixture.broker.setPaused(threadId, true);
        expect(JSON.stringify(result)).toContain("READY");
      } finally {
        clearTimeout(deadline);
        q.close();
        input.end();
        computer.dispose?.();
        fixture.broker.close();
        await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }, 120_000);
  },
);
