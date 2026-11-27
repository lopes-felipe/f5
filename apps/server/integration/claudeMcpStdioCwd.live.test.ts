import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

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

// A stdio server that records its working directory and answers just enough MCP
// for the CLI to finish connecting.
const SERVER_SOURCE = `
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], process.cwd());
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "cwd-probe", version: "1.0.0" },
          }
        : { tools: [] };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  }
});
`;

// Explicit opt-in. F5 documents stdio `cwd` as ignored by Claude because the SDK's
// McpStdioServerConfig has no such field; this test pins that behaviour.
describe.skipIf(process.env.F5_CLAUDE_LIVE_TEST !== "1")("Claude stdio MCP cwd", () => {
  it("starts stdio servers in the session directory, not the configured cwd", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "f5-claude-mcp-cwd-")));
    try {
      const sessionCwd = join(root, "session");
      const serverCwd = join(root, "server");
      const script = join(root, "server.mjs");
      const output = join(root, "cwd.txt");
      await Promise.all([mkdir(sessionCwd), mkdir(serverCwd), writeFile(script, SERVER_SOURCE)]);
      const server = {
        type: "stdio",
        command: process.execPath,
        args: [script, output],
        cwd: serverCwd,
      } as McpServerConfig;
      for await (const _message of query({
        prompt: "Reply with the single word ok.",
        options: {
          cwd: sessionCwd,
          env: environment,
          maxTurns: 1,
          model: "haiku",
          tools: [],
          mcpServers: { cwd_probe: server },
        },
      })) {
        // Drain the run; the server records its cwd when it is spawned.
      }
      const observed = await readFile(output, "utf8");
      // If this starts failing with serverCwd, Claude now honours `cwd`: remove the
      // "Ignored by Claude" label in McpServerEditor and the docs note.
      expect(observed).toBe(sessionCwd);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
