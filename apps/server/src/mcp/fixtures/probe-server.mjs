import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const mode = process.argv[2];
if (process.env.ACCOUNT_TOKEN) process.stderr.write(process.env.ACCOUNT_TOKEN + "\n");
if (process.env.PROBE_TOKEN) process.stderr.write(`token=${process.env.PROBE_TOKEN}\n`);
if (mode === "fail") process.exit(1);
if (mode.includes("grandchild")) {
  const child = spawn(
    process.execPath,
    ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
    { stdio: "ignore" },
  );
  writeFileSync(process.argv[3], String(child.pid));
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined || mode.startsWith("hang")) return;
  const respond = (result) =>
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
  if (request.method === "initialize")
    respond({
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: "probe-fixture", version: "1" },
    });
  else if (request.method === "tools/list")
    respond({
      tools: Array.from({ length: mode === "many" ? 250 : 1 }, (_, index) => ({
        name: mode === "sanitizer-growth" ? "abcdefgh".repeat(16) : `tool${index}`,
        description: mode === "sanitizer-growth" ? "abcdefgh".repeat(37) : "A fixture tool",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      })),
    });
  else if (request.method === "resources/list")
    respond({ resources: [{ uri: "fixture://example", name: "Example" }] });
  else if (request.method === "prompts/list") respond({ prompts: [{ name: "fixture" }] });
});
