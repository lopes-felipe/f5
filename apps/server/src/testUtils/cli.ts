import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { pathToFileURL } from "node:url";

const bundles = new Map<string, string>();

function bundleAgent(agentPath: string): string {
  const existing = bundles.get(agentPath);
  if (existing) return existing;
  const directory = mkdtempSync(Path.join(tmpdir(), "f5-acp-fixture-"));
  const output = Path.join(directory, "agent.mjs");
  execFileSync("bun", ["build", agentPath, "--target=node", "--outfile", output], {
    stdio: "pipe",
    windowsHide: true,
  });
  bundles.set(agentPath, output);
  process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
  return output;
}

/** A real executable fixture that uses Node on Windows and a shebang on POSIX. */
export function writeCliScript(filePath: string, source: string): string {
  const scriptPath = filePath.endsWith(".cjs") ? filePath : `${filePath}.cjs`;
  mkdirSync(Path.dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, `#!/usr/bin/env node\n${source}\n`);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

/** Run the bundled ACP fixture in the wrapper process, preserving its lifecycle. */
export function writeAcpWrapper(
  filePath: string,
  agentPath: string,
  options: {
    env?: Record<string, string> | undefined;
    delayMs?: number;
    argvLogPath?: string;
    about?: string;
    requireAcp?: boolean;
  } = {},
): string {
  return writeCliScript(
    filePath,
    `
const { appendFileSync } = require("node:fs");
const options = ${JSON.stringify(options)};
Object.assign(process.env, options.env);
if (process.env.T3_ACP_EXIT_LOG_PATH) appendFileSync(process.env.T3_ACP_EXIT_LOG_PATH + ".pids", process.pid + "\\n");
if (options.argvLogPath) appendFileSync(options.argvLogPath, process.argv.slice(2).join("\\t") + "\\t\\n");
if (options.about && process.argv[2] === "about") {
  process.stdout.write(options.about);
} else if (options.requireAcp && process.argv[2] !== "acp") {
  console.error("unexpected args: " + process.argv.slice(2).join(" "));
  process.exitCode = 11;
} else {
  const start = () => import(${JSON.stringify(pathToFileURL(bundleAgent(agentPath)).href)});
  if (options.delayMs) setTimeout(start, options.delayMs); else start();
}
`,
  );
}

/** Windows terminates processes without running their signal/exit handlers. */
export async function waitForAgentExit(logPath: string, expectedCount = 1): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const pids = readFileSync(`${logPath}.pids`, "utf8").trim().split("\n").map(Number);
    const stopped = pids.every((pid) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    });
    if (pids.length === expectedCount && stopped) return;
    if (Date.now() >= deadline)
      throw new Error(`Expected ${expectedCount} ACP processes to exit: ${pids.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Put a CLI name on PATH using a conventional Node shim on Windows. */
export function writeCliCommand(filePath: string, source: string): void {
  const scriptPath = writeCliScript(filePath, source);
  if (process.platform === "win32") {
    writeFileSync(
      `${filePath}.cmd`,
      `@echo off\r\nnode "%~dp0\\${Path.basename(scriptPath)}" %*\r\n`,
    );
  } else {
    writeFileSync(filePath, `#!/usr/bin/env node\n${source}\n`);
    chmodSync(filePath, 0o755);
  }
}
