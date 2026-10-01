import { spawn, type ChildProcess } from "node:child_process";

import { killProcessTree } from "@t3tools/shared/processTree";
import { WORKTREE_SETUP_TAIL_LINE_MAX_LENGTH } from "@t3tools/contracts";
import { Data, Deferred, Effect } from "effect";

/**
 * Runs a project setup script as a process the worktree setup owns, instead of
 * typing it into a terminal. Ownership is what makes cancellation safe: the
 * setup can kill the whole process tree and wait for it to exit before it
 * removes the worktree the script was writing into.
 *
 * Colors are disabled because nothing answers terminal color probes, and each
 * output line (carriage-return redraws included) is reported with ANSI and
 * control characters removed.
 */

class SetupScriptSpawnError extends Data.TaggedError("SetupScriptSpawnError")<{
  message: string;
}> {}

export interface OwnedSetupScript {
  /** Exit code, or null when the process was killed by a signal or failed to spawn. */
  readonly exit: Effect.Effect<number | null>;
  /** Kills the process tree and waits for it to exit. Safe to call repeatedly. */
  readonly kill: Effect.Effect<void>;
}

const PARTIAL_LINE_MAX_LENGTH = 4_096;
const KILL_GRACE_MS = 3_000;

/** Removes ANSI escape sequences and cursor controls so lines can be shown as plain text. */
export function stripTerminalControl(text: string): string {
  return (
    text
      .replace(
        // eslint-disable-next-line no-control-regex
        /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g,
        "",
      )
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
  );
}

function shellInvocation(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  const shell = process.env.SHELL && process.env.SHELL.length > 0 ? process.env.SHELL : "/bin/sh";
  // A login shell picks up the same PATH the user's terminals see.
  return { file: shell, args: ["-lc", command] };
}

export const startOwnedSetupScript = (input: {
  readonly command: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly onLine: (line: string) => void;
}): Effect.Effect<OwnedSetupScript> =>
  Effect.gen(function* () {
    const exited = yield* Deferred.make<number | null>();
    const { file, args } = shellInvocation(input.command);
    let child: ChildProcess | null = null;
    let buffer = "";
    const flushLines = (chunk: string, final: boolean) => {
      buffer += chunk;
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = final ? "" : (lines.pop() ?? "");
      if (buffer.length > PARTIAL_LINE_MAX_LENGTH) buffer = buffer.slice(-PARTIAL_LINE_MAX_LENGTH);
      for (const raw of lines) {
        const line = stripTerminalControl(raw).trimEnd();
        if (line.length > 0) input.onLine(line.slice(0, WORKTREE_SETUP_TAIL_LINE_MAX_LENGTH));
      }
    };
    const settle = (code: number | null) => {
      flushLines("", true);
      Deferred.doneUnsafe(exited, Effect.succeed(code));
    };
    child = yield* Effect.try({
      try: (): ChildProcess =>
        spawn(file, args, {
          cwd: input.cwd,
          env: { ...process.env, ...input.env, NO_COLOR: "1", FORCE_COLOR: "0", CLICOLOR: "0" },
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
          windowsHide: true,
        }),
      catch: (cause) =>
        new SetupScriptSpawnError({ message: `Failed to start setup script: ${String(cause)}` }),
    }).pipe(
      Effect.catch((error) =>
        Effect.sync((): ChildProcess | null => {
          input.onLine(error.message);
          return null;
        }).pipe(Effect.tap(() => Deferred.succeed(exited, null))),
      ),
    );
    if (child) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => flushLines(chunk, false));
      child.stderr?.on("data", (chunk: string) => flushLines(chunk, false));
      child.once("error", (error) => {
        input.onLine(`Setup script error: ${error.message}`);
        settle(null);
      });
      child.once("close", (code) => settle(code));
    }
    const owned = child;
    const kill = Effect.gen(function* () {
      if (owned && owned.exitCode === null && owned.signalCode === null) {
        killProcessTree(owned, { isGroupLeader: process.platform !== "win32", graceful: true });
        const exitedInTime = yield* Deferred.await(exited).pipe(
          Effect.timeoutOption(`${KILL_GRACE_MS} millis`),
        );
        if (exitedInTime._tag === "None") {
          killProcessTree(owned, {
            isGroupLeader: process.platform !== "win32",
            signal: "SIGKILL",
          });
        }
      }
      yield* Deferred.await(exited);
    });
    return { exit: Deferred.await(exited), kill } satisfies OwnedSetupScript;
  });
