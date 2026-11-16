/** Read-only probe: initialize only, never authenticate or create/load a session. */
import { execFile, spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildCursorAcpSpawnInput } from "../src/provider/acp/CursorAcpSupport";
import { buildGrokAcpSpawnInput } from "../src/provider/acp/GrokAcpSupport";
import { antigravityEnvironment } from "../src/provider/acp/AntigravityAcpSupport";
import { AntigravityInstallation } from "../src/provider/AntigravityInstallation";
import type { AcpSpawnInput } from "../src/provider/acp/AcpSessionRuntime";

async function initialize(input: AcpSpawnInput): Promise<unknown> {
  return new Promise((resolve) => {
    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.extendEnv === false ? input.env : { ...process.env, ...input.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const finish = (result: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 1000);
      kill.unref();
      child.once("close", () => clearTimeout(kill));
      resolve(result);
    };
    const timer = setTimeout(() => finish({ error: "initialize-timeout" }), 15_000);
    child.on("error", () => finish({ error: "cli-unavailable" }));
    child.on("exit", () => finish({ error: "cli-exited-before-initialize" }));
    child.stderr.resume();
    child.stdin.on("error", () => finish({ error: "cli-input-closed" }));
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > 1024 * 1024) return finish({ error: "output-limit" });
      let newline: number;
      while ((newline = output.indexOf("\n")) >= 0) {
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        try {
          const frame = JSON.parse(line);
          if (frame.id === 1 && frame.result)
            finish({
              agentInfo: frame.result.agentInfo,
              mcpCapabilities: frame.result.agentCapabilities?.mcpCapabilities ?? {},
            });
          else if (frame.id === 1 && frame.error) finish({ error: "initialize-rejected" });
        } catch {
          /* Some CLIs print non-protocol startup notices. */
        }
      }
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "f5-capability-probe", version: "1" },
        },
      }) + "\n",
    );
  });
}
async function version(command: string) {
  try {
    const { stdout } = await promisify(execFile)(command, ["--version"], {
      timeout: 5000,
      maxBuffer: 16_384,
    });
    return stdout.match(/\b(?:\d+\.){1,3}\d+(?:[-+][a-zA-Z0-9.-]+)?/)?.[0] ?? "unreported";
  } catch {
    return "unavailable";
  }
}
const cwd = process.cwd();
const results: Record<string, unknown> = {};
results.cursor = {
  version: await version("agent"),
  result: await initialize(buildCursorAcpSpawnInput(undefined, cwd)),
};
results.grok = {
  version: await version("grok"),
  result: await initialize(buildGrokAcpSpawnInput(undefined, cwd, process.env)),
};
const stateArg = process.argv.indexOf("--state-dir");
if (stateArg < 0 || !process.argv[stateArg + 1])
  results.antigravity = { error: "provide-state-dir-for-managed-installation" };
else {
  try {
    const executable = await new AntigravityInstallation(
      path.resolve(process.argv[stateArg + 1]!),
    ).resolve();
    const home = await mkdtemp(path.join(tmpdir(), "f5-acp-probe-"));
    results.antigravity = {
      version: executable.version,
      result: await initialize({
        command: executable.executablePath,
        args: process.platform === "linux" ? ["--uid="] : [],
        cwd,
        env: antigravityEnvironment(process.env, home, executable.harnessPath, "false"),
        extendEnv: false,
      }),
    };
  } catch {
    results.antigravity = { error: "managed-cli-unavailable" };
  }
}
process.stdout.write(
  JSON.stringify(
    { at: new Date().toISOString(), platform: process.platform, arch: process.arch, results },
    null,
    2,
  ) + "\n",
);
