import { type ChildProcess as ChildProcessHandle, spawn } from "node:child_process";
import { killProcessTree } from "@t3tools/shared/processTree";
import { ensureWindowsPathHydrated } from "@t3tools/shared/windowsPath";

import { resolveExecutable, resolveInvocation } from "./spawn/resolveCommand.ts";
import { resolveProfileGithubLauncher } from "./git/GithubCliLauncher";
import { isManagedGitCommand, managedGitProcessEnvironment } from "./git/gitProcessEnvironment.ts";

export interface ProcessRunOptions {
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
  env: NodeJS.ProcessEnv;
  stdin?: string | undefined;
  allowNonZeroExit?: boolean | undefined;
  maxBufferBytes?: number | undefined;
  maxStdoutBytes?: number | undefined;
  maxStderrBytes?: number | undefined;
  outputMode?: "error" | "truncate" | "tail" | undefined;
  signal?: AbortSignal | undefined;
}

export interface ProcessRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted?: boolean | undefined;
  stdoutTruncated?: boolean | undefined;
  stderrTruncated?: boolean | undefined;
}

function commandLabel(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ");
}

function normalizeSpawnError(command: string, args: readonly string[], error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(`Failed to run ${commandLabel(command, args)}.`);
  }

  const maybeCode = (error as NodeJS.ErrnoException).code;
  if (maybeCode === "ENOENT") {
    return new Error(`Command not found: ${command}`);
  }

  return new Error(`Failed to run ${commandLabel(command, args)}: ${error.message}`);
}

const WINDOWS_COMMAND_NOT_FOUND_PATTERNS = [
  /is not recognized as an internal or external command/i,
  /n.o . reconhecido como um comando interno/i,
  /non . riconosciuto come comando interno o esterno/i,
  /n.est pas reconnu en tant que commande interne/i,
  /no se reconoce como un comando interno o externo/i,
  /wird nicht als interner oder externer befehl/i,
] as const;

function hasWindowsCommandNotFoundMessage(output: string): boolean {
  return WINDOWS_COMMAND_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(output));
}

export function isWindowsCommandNotFound(code: number | null, stderr: string): boolean {
  if (process.platform !== "win32") return false;
  if (code === 9009) return true;
  return hasWindowsCommandNotFoundMessage(stderr);
}

function normalizeExitError(
  command: string,
  args: readonly string[],
  result: ProcessRunResult,
): Error {
  if (isWindowsCommandNotFound(result.code, result.stderr)) {
    return new Error(`Command not found: ${command}`);
  }

  const reason = result.timedOut
    ? "timed out"
    : `failed (code=${result.code ?? "null"}, signal=${result.signal ?? "null"})`;
  const stderr = result.stderr.trim();
  const detail = stderr.length > 0 ? ` ${stderr}` : "";
  return new Error(`${commandLabel(command, args)} ${reason}.${detail}`);
}

function normalizeStdinError(command: string, args: readonly string[], error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(`Failed to write stdin for ${commandLabel(command, args)}.`);
  }
  return new Error(`Failed to write stdin for ${commandLabel(command, args)}: ${error.message}`);
}

function normalizeBufferError(
  command: string,
  args: readonly string[],
  stream: "stdout" | "stderr",
  maxBufferBytes: number,
): Error {
  return new Error(
    `${commandLabel(command, args)} exceeded ${stream} buffer limit (${maxBufferBytes} bytes).`,
  );
}

const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/** Terminate the command and every subprocess that inherited its stdio. */
function killChild(child: ChildProcessHandle, signal: NodeJS.Signals = "SIGTERM"): void {
  killProcessTree(child, { isGroupLeader: process.platform !== "win32", signal });
}

function appendChunkWithinLimit(
  target: string,
  currentBytes: number,
  chunk: Buffer,
  maxBytes: number,
): {
  next: string;
  nextBytes: number;
  truncated: boolean;
} {
  const remaining = maxBytes - currentBytes;
  if (remaining <= 0) {
    return { next: target, nextBytes: currentBytes, truncated: true };
  }
  if (chunk.length <= remaining) {
    return {
      next: `${target}${chunk.toString()}`,
      nextBytes: currentBytes + chunk.length,
      truncated: false,
    };
  }
  return {
    next: `${target}${chunk.subarray(0, remaining).toString()}`,
    nextBytes: currentBytes + remaining,
    truncated: true,
  };
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessRunOptions,
): Promise<ProcessRunResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const maxStdoutBytes = options.maxStdoutBytes ?? maxBufferBytes;
  const maxStderrBytes = options.maxStderrBytes ?? maxBufferBytes;
  const outputMode = options.outputMode ?? "error";
  const environment = isManagedGitCommand(command)
    ? managedGitProcessEnvironment(options.env)
    : options.env;
  await ensureWindowsPathHydrated(environment);
  const executable =
    process.platform === "win32"
      ? resolveExecutable(command, environment, { cwd: options.cwd })
      : null;
  const profileLauncher = executable ? resolveProfileGithubLauncher(executable, environment) : null;
  const invocation = profileLauncher
    ? { file: profileLauncher.runtime, args: [profileLauncher.script, ...args] }
    : resolveInvocation(command, args, environment, { cwd: options.cwd });
  const spawnEnvironment = profileLauncher
    ? { ...environment, ELECTRON_RUN_AS_NODE: "1" }
    : environment;

  return new Promise<ProcessRunResult>((resolve, reject) => {
    const child = spawn(invocation.file, [...invocation.args], {
      cwd: options.cwd,
      env: spawnEnvironment,
      stdio: "pipe",
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let stdoutTail: Buffer = Buffer.alloc(0);
    let stderrTail: Buffer = Buffer.alloc(0);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let processFailure: Error | null = null;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    let terminating = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;

    const finalize = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (drainTimer) clearTimeout(drainTimer);
      options.signal?.removeEventListener("abort", abortHandler);
      callback();
    };
    const finish = () => {
      const result: ProcessRunResult = {
        stdout: outputMode === "tail" ? stdoutTail.toString() : stdout,
        stderr: outputMode === "tail" ? stderrTail.toString() : stderr,
        code: exitCode,
        signal: exitSignal,
        timedOut,
        aborted,
        stdoutTruncated,
        stderrTruncated,
      };
      finalize(() => {
        if (processFailure) reject(processFailure);
        else if (!options.allowNonZeroExit && (timedOut || (exitCode !== null && exitCode !== 0)))
          reject(normalizeExitError(command, args, result));
        else resolve(result);
      });
    };
    const drainPipes = () => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      finish();
    };
    const terminateProcessGroup = () => {
      if (terminating || settled) return;
      terminating = true;
      clearTimeout(timeoutTimer);
      killChild(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        killChild(child, "SIGKILL");
        // An escaped daemon can retain our pipes after its process group is gone.
        // Bound pipe draining too, so cancellation always settles and releases callers.
        if (drainTimer) clearTimeout(drainTimer);
        drainTimer = setTimeout(drainPipes, 100);
      }, 1_000);
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateProcessGroup();
    }, timeoutMs);
    const abortHandler = () => {
      aborted = true;
      terminateProcessGroup();
    };
    options.signal?.addEventListener("abort", abortHandler, { once: true });
    if (options.signal?.aborted) abortHandler();

    const fail = (error: Error): void => {
      processFailure ??= error;
      terminateProcessGroup();
    };

    const appendOutput = (stream: "stdout" | "stderr", chunk: Buffer | string): Error | null => {
      if (processFailure) return null;
      const chunkBuffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      if (outputMode === "tail") {
        const previous = stream === "stdout" ? stdoutTail : stderrTail;
        const limit = stream === "stdout" ? maxStdoutBytes : maxStderrBytes;
        const combined = Buffer.concat([previous, chunkBuffer]);
        const dropped = combined.length > limit;
        const tail = combined.subarray(Math.max(0, combined.length - limit));
        if (stream === "stdout") {
          stdoutTail = tail;
          stdoutTruncated ||= dropped;
        } else {
          stderrTail = tail;
          stderrTruncated ||= dropped;
        }
        return null;
      }
      const text = chunkBuffer.toString();
      const byteLength = chunkBuffer.length;
      if (stream === "stdout") {
        if (outputMode === "truncate") {
          const appended = appendChunkWithinLimit(stdout, stdoutBytes, chunkBuffer, maxStdoutBytes);
          stdout = appended.next;
          stdoutBytes = appended.nextBytes;
          stdoutTruncated = stdoutTruncated || appended.truncated;
          return null;
        }
        stdout += text;
        stdoutBytes += byteLength;
        if (stdoutBytes > maxStdoutBytes) {
          return normalizeBufferError(command, args, "stdout", maxStdoutBytes);
        }
      } else {
        if (outputMode === "truncate") {
          const appended = appendChunkWithinLimit(stderr, stderrBytes, chunkBuffer, maxStderrBytes);
          stderr = appended.next;
          stderrBytes = appended.nextBytes;
          stderrTruncated = stderrTruncated || appended.truncated;
          return null;
        }
        stderr += text;
        stderrBytes += byteLength;
        if (stderrBytes > maxStderrBytes) {
          return normalizeBufferError(command, args, "stderr", maxStderrBytes);
        }
      }
      return null;
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      const error = appendOutput("stdout", chunk);
      if (error) {
        fail(error);
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const error = appendOutput("stderr", chunk);
      if (error) {
        fail(error);
      }
    });

    child.once("error", (error) => {
      finalize(() => {
        reject(normalizeSpawnError(command, args, error));
      });
    });

    child.once("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      if (!terminating) {
        // The command has completed; inherited pipes must not turn its success into a timeout.
        clearTimeout(timeoutTimer);
        drainTimer = setTimeout(() => {
          killChild(child, "SIGKILL");
          drainPipes();
        }, 1000);
      }
    });
    child.once("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      // Closing the parent must not strand descendants which ignored SIGTERM.
      // Escalate any remaining group immediately; an ordinary exit incurs no delay.
      if (terminating) killChild(child, "SIGKILL");
      finish();
    });

    child.stdin.once("error", (error) => {
      fail(normalizeStdinError(command, args, error));
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin, (error) => {
        if (error) {
          fail(normalizeStdinError(command, args, error));
          return;
        }
        child.stdin.end();
      });
      return;
    }
    child.stdin.end();
  });
}
