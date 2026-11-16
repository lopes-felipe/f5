import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

/** Run internal .NET operations without inheriting PowerShell 7's module search path. */
export async function runWindowsPowerShell(
  script: string,
  options: { timeoutMs: number; maxBuffer?: number },
) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment))
    if (key.toLowerCase() === "psmodulepath") delete environment[key];
  const program = path.win32.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const source =
    "$PSModuleAutoLoadingPreference = 'None'; $ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'; " +
    script;
  const pending = promisify(execFile)(
    program,
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(source, "utf16le").toString("base64"),
    ],
    {
      env: environment,
      windowsHide: true,
      timeout: options.timeoutMs,
      ...(options.maxBuffer ? { maxBuffer: options.maxBuffer } : {}),
    },
  );
  pending.child.stdin?.end();
  return await pending;
}

/** JavaScriptSerializer is available in Windows PowerShell's .NET Framework. */
export const WINDOWS_JSON_SERIALIZER =
  "$null = [System.Reflection.Assembly]::LoadWithPartialName('System.Web.Extensions'); $json = [System.Web.Script.Serialization.JavaScriptSerializer]::new(); ";
