import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { release } from "node:os";

export interface WindowsDesktopProbe {
  elevated: boolean;
  activeSession: boolean;
  defaultDesktop: boolean;
  sessionId: number;
}
export function windowsRunnerChecks(probe: WindowsDesktopProbe, build: number, version?: string) {
  return {
    supportedBuild: Number.isInteger(build) && build >= 19041,
    expectedVersion:
      version === undefined ||
      (version === "windows-10" && build < 22000) ||
      (version === "windows-11" && build >= 22000),
    unelevated: probe.elevated === false,
    activeSession:
      probe.activeSession === true && Number.isInteger(probe.sessionId) && probe.sessionId > 0,
    unlockedDesktop: probe.defaultDesktop === true,
  };
}
/** Read-only native session preflight. No capture, hooks, grants or input. */
export async function probeWindowsRunner(version?: string) {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("Windows acceptance requires a Windows x64 desktop.");
  const source = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class F5DesktopReadiness {
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int cls, out int value, int length, out int needed);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("wtsapi32.dll", CharSet=CharSet.Unicode)] static extern bool WTSQuerySessionInformation(IntPtr server, int session, int cls, out IntPtr value, out int bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr value);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj, int cls, StringBuilder text, int size, out int needed);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  static string Name(IntPtr desktop) {
    var text = new StringBuilder(256); int needed;
    if (desktop == IntPtr.Zero || !GetUserObjectInformation(desktop, 2, text, 512, out needed)) return "";
    return text.ToString();
  }
  public static string Run() {
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(), 8, out token)) throw new Exception("Token unavailable");
    int elevation, needed;
    try { if (!GetTokenInformation(token, 20, out elevation, 4, out needed)) throw new Exception("Elevation unavailable"); }
    finally { CloseHandle(token); }
    int session = Process.GetCurrentProcess().SessionId;
    IntPtr value; int bytes; bool active = false;
    if (WTSQuerySessionInformation(IntPtr.Zero, session, 8, out value, out bytes)) {
      try { active = bytes >= 4 && Marshal.ReadInt32(value) == 0; } finally { WTSFreeMemory(value); }
    }
    var desktop = OpenInputDesktop(0, false, 1);
    bool unlocked = false;
    try { unlocked = Name(desktop) == "Default" && Name(GetThreadDesktop(GetCurrentThreadId())) == "Default"; }
    finally { if (desktop != IntPtr.Zero) CloseDesktop(desktop); }
    return "{\"elevated\":" + (elevation != 0 ? "true" : "false") + ",\"activeSession\":" + (active ? "true" : "false") +
      ",\"defaultDesktop\":" + (unlocked ? "true" : "false") + ",\"sessionId\":" + session + "}";
  }
}
'@
[F5DesktopReadiness]::Run()
`;
  const result = await promisify(execFile)(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(source, "utf16le").toString("base64"),
    ],
    { timeout: 20000, maxBuffer: 4096, windowsHide: true },
  );
  const probe = JSON.parse(result.stdout.trim()) as WindowsDesktopProbe;
  return windowsRunnerChecks(probe, Number(release().split(".")[2]), version);
}
if (import.meta.main) {
  try {
    const checks = await probeWindowsRunner(process.argv[2]);
    process.stdout.write(
      JSON.stringify({ checks, ready: Object.values(checks).every(Boolean) }) + "\n",
    );
    if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
  } catch {
    process.stderr.write(
      "Windows runner is unavailable. Use an unelevated runner launched in an unlocked interactive Windows x64 session.\n",
    );
    process.exitCode = 1;
  }
}
