import { runProcess } from "../processRunner";

/** Parent PIDs with at least one live child, shared by every terminal in a poll. */
export type TerminalProcessTable = ReadonlySet<number>;

export function parseTerminalProcessTable(
  stdout: string,
  platform: NodeJS.Platform,
): TerminalProcessTable {
  const parents = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.trim().split(platform === "win32" ? "|" : /\s+/);
    if (fields.length !== 2 || !fields.every((field) => /^\d+$/.test(field)))
      throw new Error("Invalid terminal process table row");
    const [pid, parent] = fields.map(Number);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parent))
      throw new Error("Invalid process ID");
    if (pid! > 0 && parent! > 0) parents.add(parent!);
  }
  if (!stdout.trim()) throw new Error("Empty terminal process table");
  return parents;
}

export async function readTerminalProcessTable(
  platform: NodeJS.Platform = process.platform,
): Promise<TerminalProcessTable> {
  const windows = platform === "win32";
  const options = {
    env: process.env,
    timeoutMs: windows ? 1500 : 1000,
    maxBufferBytes: 1024 * 1024,
    outputMode: "error" as const,
  };
  const result = await runProcess(
    windows ? "powershell.exe" : "ps",
    windows
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          '$ErrorActionPreference = "Stop"; Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { Write-Output "$($_.ProcessId)|$($_.ParentProcessId)" }',
        ]
      : ["-eo", "pid=,ppid="],
    options,
  ).catch(async (error: unknown) => {
    if (windows) throw error;
    // BusyBox builds may not support -e or header suppression. This still reads
    // one complete table; never turn a partial/failed probe into idle activity.
    const fallback = await runProcess("ps", ["-A", "-o", "pid,ppid"], options);
    const lines = fallback.stdout.trim().split(/\r?\n/);
    if (!/^\s*PID\s+PPID\s*$/.test(lines[0] ?? "")) throw error;
    return { ...fallback, stdout: lines.slice(1).join("\n") };
  });
  // The runner rejects nonzero exits, timeouts and output overflow. A process
  // killed by a signal can instead resolve with a null exit code.
  if (result.signal) throw new Error("Terminal process table probe was interrupted");
  return parseTerminalProcessTable(result.stdout, platform);
}
