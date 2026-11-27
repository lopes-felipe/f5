import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { query, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { ThreadId, type McpProjectServersConfig } from "@t3tools/contracts";
import { translateMcpForClaudeAgent } from "@t3tools/shared/mcpTranslation";
import { Effect, Exit, Scope } from "effect";
import { describe, expect, it } from "vitest";

import { makeMcpHub } from "../src/mcp/hub/McpHub.ts";
import { hubEndpointsForClaude } from "../src/mcp/hub/providerHubServers.ts";
import {
  makePreviewAutomationBroker,
  PreviewAutomationBroker,
} from "../src/mcp/PreviewAutomationBroker.ts";
import { makePreviewMcpHttpServer } from "../src/mcp/PreviewMcpHttpServer.ts";

// Same neutral environment as the other Claude live tests: the selected account's
// home and credential routing only.
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      [
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "PATH",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "TMPDIR",
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "NODE_EXTRA_CA_CERTS",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "NO_PROXY",
      ].includes(key) ||
      key.startsWith("ANTHROPIC_") ||
      key.startsWith("AWS_") ||
      key === "CLAUDE_CODE_USE_BEDROCK",
  ),
);

const fixture = fileURLToPath(new URL("../src/mcp/fixtures/hub-server.mjs", import.meta.url));
const SECRET = "hub-live-secret-value-123";

// Explicit opt-in. The MCP hub parity gate for Claude: a real Claude CLI reaches a
// stdio server through F5's hub endpoint, with the hub's working directory, tool
// filters, and elicitation forwarding, and never sees the server's secrets.
describe.skipIf(process.env.F5_CLAUDE_LIVE_TEST !== "1")("Claude through the F5 MCP hub", () => {
  it("calls tools, answers questions, and runs stdio servers in the session directory", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "f5-claude-mcp-hub-")));
    const scope = Effect.runSync(Scope.make());
    try {
      const listener = await Effect.runPromise(
        makePreviewMcpHttpServer.pipe(
          Effect.provideService(PreviewAutomationBroker, makePreviewAutomationBroker()),
          Scope.provide(scope),
        ),
      );
      const hub = makeMcpHub({ listener });
      const sessionCwd = join(root, "session");
      const report = join(root, "report.json");
      await mkdir(sessionCwd);
      const servers: McpProjectServersConfig = {
        fixture: {
          type: "stdio",
          command: process.execPath,
          args: [fixture, report],
          env: { HUB_FIXTURE_TOKEN: SECRET },
          disabledTools: ["hidden"],
        },
      };
      const attachment = hub.attach({
        threadId: ThreadId.makeUnsafe("claude-hub-live"),
        provider: "claudeAgent",
        accountKey: "claudeAgent",
        servers,
        environment: process.env,
        cwd: sessionCwd,
      });
      try {
        const mcpServers = translateMcpForClaudeAgent(
          hubEndpointsForClaude(attachment.endpoints, servers),
        ) as Record<string, McpServerConfig>;
        expect(JSON.stringify(mcpServers)).not.toContain(SECRET);
        const questions: string[] = [];
        const messages: unknown[] = [];
        for await (const message of query({
          prompt:
            "Use the fixture MCP server: call its echo tool with text 'parity', then call its ask tool. Reply with both tool outputs verbatim.",
          options: {
            cwd: sessionCwd,
            env: environment,
            maxTurns: 6,
            model: "haiku",
            tools: [],
            allowedTools: ["mcp__fixture__echo", "mcp__fixture__ask"],
            mcpServers,
            onElicitation: async (request) => {
              questions.push(request.message);
              return { action: "accept", content: { color: "teal" } };
            },
          },
        })) {
          messages.push(message);
        }
        const transcript = JSON.stringify(messages);
        expect(transcript).toContain("echo:parity");
        expect(questions).toEqual(["Pick a color"]);
        expect(transcript).toContain("accept:teal");
        // F5 filtered the disabled tool before Claude listed tools.
        expect(transcript).not.toContain("mcp__fixture__hidden");
        const observed = JSON.parse(await readFile(report, "utf8")) as { cwd: string };
        expect(observed.cwd).toBe(sessionCwd);
      } finally {
        await attachment.dispose();
        await hub.close();
      }
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
