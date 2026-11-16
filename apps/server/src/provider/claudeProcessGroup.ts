import * as NodeChildProcess from "node:child_process";

import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

const GROUP_WATCH_SCRIPT = [
  "{ trap '' TERM; read -r _ <&3; kill -TERM 0; sleep 5; kill -KILL 0; } </dev/null >/dev/null 2>&1 &",
  'exec "$@" 3<&-',
].join("\n");

/**
 * Starts the Claude CLI as the leader of its own process group. When the CLI
 * exits it stops the MCP servers it started, but not their children: a
 * plugin's `bun run start` wrapper dies and its `bun server.ts` keeps running.
 * Those stay in the CLI's group, so the rest of the group gets SIGKILL once
 * the CLI exits for any reason. A watcher in that group also terminates it when
 * the server-held pipe closes, including when the server crashes or is killed.
 * Commands the agent runs through its Bash tool
 * start their own groups, so background jobs it launched are not part of this.
 *
 * The SDK reads stderr only from its own spawn, so stderr is forwarded to
 * `onStderr` here. Returns undefined on Windows, which has no process groups;
 * the SDK's own spawn is used there.
 */
export function makeClaudeProcessGroupSpawner(
  onStderr: (data: string) => void,
  platform: NodeJS.Platform = process.platform,
): ((options: SpawnOptions) => SpawnedProcess) | undefined {
  if (platform === "win32") return undefined;
  return (options) => {
    const child = NodeChildProcess.spawn(
      "/bin/sh",
      ["-c", GROUP_WATCH_SCRIPT, "f5-claude", options.command, ...options.args],
      {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env: options.env,
        signal: options.signal,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        detached: true,
      },
    );
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", onStderr);
    child.once("exit", () => {
      // Without a pid the spawn failed, and -0 would signal F5's own group.
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is already empty.
      }
    });
    // stdin, stdout and stderr are pipes; Node's fourth-descriptor overload is nullable.
    return child as SpawnedProcess;
  };
}
