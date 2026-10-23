import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { query, type Options, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { ThreadId } from "@t3tools/contracts";
import { CLAUDE_SDK_BASELINE_VERSION } from "@t3tools/shared/claudeSdkManifest";
import { makePreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { forceClaudeChromeFlag, makeClaudePreviewMcpServer } from "./claudeAgentBrowser.ts";
import { FakeClaudeCodeProcess, respondToInitializeRequest } from "./ClaudeSdk.testUtils.ts";
import { createClaudeQueryWithPrivateMcp } from "../claudeMcpStartup.ts";
import { makeClaudeThreadMcpServer } from "./claudeThreadTools.ts";
import { makeThreadMcpBroker } from "../../mcp/threadMcpTools.ts";
import { Effect } from "effect";

async function* emptyPrompt(): AsyncGenerator<never> {}

// The SDK does not export its package.json, so read it next to the resolved entry.
function installedClaudeSdkVersion(): string {
  const entry = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
  const manifest = JSON.parse(
    readFileSync(path.join(path.dirname(entry), "package.json"), "utf8"),
  ) as { version: string };
  return manifest.version;
}

beforeAll(() => {
  const installed = installedClaudeSdkVersion();
  if (installed !== CLAUDE_SDK_BASELINE_VERSION) {
    throw new Error(
      `Installed Claude SDK ${installed} does not match pinned ${CLAUDE_SDK_BASELINE_VERSION}; run bun install --frozen-lockfile`,
    );
  }
});

describe("Claude SDK host contract transport", () => {
  it("declares F5 thread tools in-process without credentials in CLI arguments", async () => {
    const broker = await Effect.runPromise(makeThreadMcpBroker);
    const server = makeClaudeThreadMcpServer({
      broker,
      threadId: ThreadId.makeUnsafe("thread-probe"),
      existingServerNames: new Set(["f5_thread"]),
    });
    let initialize: Record<string, unknown> | undefined;
    let spawn: SpawnOptions | undefined;
    const runtime = query({
      prompt: emptyPrompt(),
      options: {
        persistSession: false,
        mcpServers: { [server.serverName]: server.config },
        spawnClaudeCodeProcess: (args) => {
          spawn = args;
          return new FakeClaudeCodeProcess((message, child) => {
            if (respondToInitializeRequest(message, child))
              initialize = message.request as Record<string, unknown>;
          });
        },
      },
    });
    try {
      await runtime.initializationResult();
      expect(initialize?.sdkMcpServers).toEqual([server.serverName]);
      expect(server.serverName).not.toBe("f5_thread");
      expect(JSON.stringify(spawn?.args)).not.toContain("F5_THREAD_MCP_TOKEN");
    } finally {
      runtime.close();
    }
  });
  it("transmits configured MCP headers and env over stdin while keeping actual CLI argv private", async () => {
    const servers = {
      remote: {
        type: "http",
        url: "https://example.invalid/mcp",
        headers: { Authorization: "Bearer header-value-fixture" },
      },
      local: { type: "stdio", command: "node", env: { ACCESS_TOKEN: "env-value-fixture" } },
    } satisfies NonNullable<Options["mcpServers"]>;
    let spawn: SpawnOptions | undefined;
    let applied: unknown;
    const runtime = await createClaudeQueryWithPrivateMcp(
      {
        prompt: emptyPrompt(),
        options: {
          persistSession: false,
          mcpServers: servers,
          spawnClaudeCodeProcess: (args) => {
            spawn = args;
            return new FakeClaudeCodeProcess((message, child) => {
              if (respondToInitializeRequest(message, child)) return;
              if (
                message.type === "control_request" &&
                (message.request as { subtype?: string })?.subtype === "mcp_set_servers"
              ) {
                applied = (message.request as { servers: unknown }).servers;
                child.emitJson({
                  type: "control_response",
                  response: {
                    subtype: "success",
                    request_id: message.request_id,
                    response: { added: ["remote", "local"], removed: [], errors: {} },
                  },
                });
              }
            });
          },
        },
      },
      query,
    );
    try {
      expect(applied).toEqual(servers);
      expect(JSON.stringify(spawn!.args)).not.toContain("header-value-fixture");
      expect(JSON.stringify(spawn!.args)).not.toContain("env-value-fixture");
      expect(spawn!.args).not.toContain("--mcp-config");
    } finally {
      runtime.close();
    }
  });
  it.each([undefined, "550e8400-e29b-41d4-a716-446655440000"])(
    "serializes host instructions and mandatory flags (resume=%s)",
    async (resume) => {
      let initialize: Record<string, unknown> | undefined;
      let spawn: SpawnOptions | undefined;
      const options = {
        ...(resume ? { resume } : {}),
        persistSession: false,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: "F5 sentinel",
          snapshot: false,
        },
        planModeInstructions: "F5 plan sentinel",
        permissionMode: "default",
        effort: "xhigh",
        thinking: { type: "disabled" },
        disallowedTools: ["Agent", "Task"],
        spawnClaudeCodeProcess: (args) => {
          spawn = args;
          return new FakeClaudeCodeProcess((message, child) => {
            if (respondToInitializeRequest(message, child)) {
              initialize = message.request as Record<string, unknown>;
            }
          });
        },
      } satisfies Options;
      const runtime = query({ prompt: emptyPrompt(), options });
      try {
        await runtime.initializationResult();
        expect(initialize).toMatchObject({
          appendSystemPrompt: "F5 sentinel",
          systemPromptSnapshot: false,
          planModeInstructions: "F5 plan sentinel",
        });
        const args = spawn!.args;
        for (const [flag, value] of [
          ["--permission-mode", "default"],
          ["--effort", "xhigh"],
          ["--disallowedTools", "Agent,Task"],
        ] as const) {
          expect(args, flag).toContain(`${flag}=${value}`);
        }
        expect(args).toContain("--thinking=disabled");
      } finally {
        runtime.close();
      }
    },
  );

  it.each([true, false])(
    "declares the in-process F5 preview server and forces Chrome flags (chrome=%s)",
    async (chromeAllowed) => {
      let initialize: Record<string, unknown> | undefined;
      let spawn: SpawnOptions | undefined;
      const preview = makeClaudePreviewMcpServer({
        broker: makePreviewAutomationBroker(),
        threadId: ThreadId.makeUnsafe("thread-probe"),
        existingServerNames: new Set(),
      });
      const options = {
        persistSession: false,
        mcpServers: { [preview.serverName]: preview.config },
        extraArgs: forceClaudeChromeFlag({ chrome: null }, chromeAllowed),
        spawnClaudeCodeProcess: (args) => {
          spawn = args;
          return new FakeClaudeCodeProcess((message, child) => {
            if (respondToInitializeRequest(message, child)) {
              initialize = message.request as Record<string, unknown>;
            }
          });
        },
      } satisfies Options;
      const runtime = query({ prompt: emptyPrompt(), options });
      try {
        await runtime.initializationResult();
        // In-process servers are declared to the CLI by name in initialize, never via argv.
        expect(initialize?.sdkMcpServers).toEqual(["f5_preview"]);
        const args = spawn!.args;
        expect(args).toContain(chromeAllowed ? "--chrome" : "--no-chrome");
        expect(args).not.toContain(chromeAllowed ? "--no-chrome" : "--chrome");
        expect(JSON.stringify(args)).not.toContain("F5_PREVIEW_MCP_TOKEN");
      } finally {
        runtime.close();
      }
    },
  );
});
