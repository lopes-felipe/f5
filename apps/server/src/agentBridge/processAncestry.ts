/**
 * Process-tree check for the Agent Bridge recursion guard. Environment
 * markers do not survive every launcher (Codex starts stdio MCP servers with
 * a cleared environment), so the STDIO shim also refuses to serve when the F5
 * server that wrote `local.json` is one of its ancestors.
 *
 * POSIX only; on Windows the environment marker is the only guard.
 *
 * @module agentBridge/processAncestry
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MAX_DEPTH = 64;

/** The parent of `pid`, or null when it cannot be read. */
export function parentProcessId(pid: number): number | null {
  if (process.platform === "win32") return null;
  if (process.platform === "linux") {
    try {
      // Field 4 of /proc/<pid>/stat, after the parenthesized command name.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const parent = Number.parseInt(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1] ?? "", 10);
      return Number.isInteger(parent) && parent > 0 ? parent : null;
    } catch {
      return null;
    }
  }
  try {
    const output = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
    const parent = Number.parseInt(output.trim(), 10);
    return Number.isInteger(parent) && parent > 0 ? parent : null;
  } catch {
    return null;
  }
}

/**
 * Whether `target` is `start` or one of its ancestors. The walk starts at the
 * parent by default: the shim never runs inside the server process itself.
 */
export function isAncestorProcess(
  target: number,
  start: number = process.ppid,
  parentOf: (pid: number) => number | null = parentProcessId,
): boolean {
  let pid: number | null = start;
  for (let depth = 0; pid !== null && pid > 1 && depth < MAX_DEPTH; depth += 1) {
    if (pid === target) return true;
    const next = parentOf(pid);
    if (next === pid) return false;
    pid = next;
  }
  return pid === target;
}
