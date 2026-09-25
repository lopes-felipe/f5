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
    {
      env: process.env,
      timeoutMs: windows ? 1500 : 1000,
      maxBufferBytes: 1024 * 1024,
      outputMode: "error",
    },
  );
  // Reject failed/partial tables: the caller keeps the last known activity state.
  if (result.code !== 0 || result.timedOut || result.stdoutTruncated)
    throw new Error("Terminal process table read failed");
  return parseTerminalProcessTable(result.stdout, platform);
}
