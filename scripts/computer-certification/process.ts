import { spawn } from "node:child_process";
import type { Command } from "./commands";
import { mkdtemp, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function cleanEnvironment(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "LOCALAPPDATA",
    "APPDATA",
    "USERPROFILE",
    "LANG",
    "LC_ALL",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, VITEST_MAX_WORKERS: "2", ...extra };
}
export interface Execution {
  readonly code: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly interrupted: boolean;
}
/** Software logs are private diagnostics. Provider/native IO is never logged. */
export async function execute(command: Command, cwd: string): Promise<Execution> {
  const logRoot = command.check
    ? await mkdtemp(join(tmpdir(), "f5-certification-software-log-"))
    : undefined;
  const logPath = logRoot ? join(logRoot, "output.log") : undefined;
  const log = logPath ? await open(logPath, "wx", 0o600) : undefined;
  let logWrites = Promise.resolve();
  let logBytes = 0;
  const diagnostic = (chunk: Buffer) => {
    if (!log || logBytes >= 32 * 1024 * 1024) return;
    const bounded = Buffer.from(chunk.subarray(0, 32 * 1024 * 1024 - logBytes));
    logBytes += bounded.length;
    logWrites = logWrites
      .then(async () => {
        await log.write(bounded);
      })
      .catch(() => {});
  };
  return new Promise((done) => {
    const child = spawn(command.executable, [...command.args], {
      cwd,
      env: cleanEnvironment(command.env),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // Own process group: interrupt only this suite's child tree, never arbitrary apps.
      detached: process.platform !== "win32",
    });
    let timedOut = false;
    let interrupted = false;
    let buffer = "";
    let force: ReturnType<typeof setTimeout> | undefined;
    const signal = (name: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(name);
        else process.kill(-child.pid, name);
      } catch {
        /* Already exited. */
      }
    };
    const stop = () => {
      interrupted = true;
      signal("SIGINT");
      force ??= setTimeout(() => signal("SIGKILL"), 5000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, command.timeoutMs);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    child.stdout.on("data", (chunk: Buffer) => {
      diagnostic(chunk);
      buffer = (buffer + chunk.toString()).slice(-8192);
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (
          /^(Click Review access|Access confirmed|Wait for the separate fixture|Stop check finished|Test closed|First turn finished|Click Resume|Press Control|Watch the fixture)/.test(
            line,
          )
        )
          process.stdout.write(line.slice(0, 1000) + "\n");
      }
    });
    child.stderr.on("data", diagnostic);
    child.once("error", () => {
      /* close settles correlation even on spawn failure. */
    });
    child.once("close", async (code, sig) => {
      clearTimeout(timer);
      clearTimeout(force);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await logWrites;
      await log?.close();
      if (code !== 0 && logPath) process.stdout.write("Software diagnostic: " + logPath + "\n");
      done({ code, signal: sig, timedOut, interrupted });
    });
  });
}
