import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface WindowsFreezeObservation {
  suspended: boolean;
  threadCount: number;
  queriedThreads: number;
  suspendedThreads: number;
  queryFailures: number;
  minimumSuspendCount: number;
  threadSetStable: boolean;
  timedOut: boolean;
  elapsedMs: number;
}
export function decodeWindowsFreezeObservation(value: unknown): WindowsFreezeObservation {
  const invalid = () => new Error("Invalid freeze observation");
  if (!value || typeof value !== "object") throw invalid();
  const v = value as Record<string, unknown>;
  for (const key of ["suspended", "threadSetStable", "timedOut"])
    if (typeof v[key] !== "boolean") throw invalid();
  for (const key of [
    "threadCount",
    "queriedThreads",
    "suspendedThreads",
    "queryFailures",
    "minimumSuspendCount",
    "elapsedMs",
  ])
    if (!Number.isSafeInteger(v[key]) || (v[key] as number) < 0) throw invalid();
  const observation: WindowsFreezeObservation = {
    suspended: v.suspended as boolean,
    threadCount: v.threadCount as number,
    queriedThreads: v.queriedThreads as number,
    suspendedThreads: v.suspendedThreads as number,
    queryFailures: v.queryFailures as number,
    minimumSuspendCount: v.minimumSuspendCount as number,
    threadSetStable: v.threadSetStable as boolean,
    timedOut: v.timedOut as boolean,
    elapsedMs: v.elapsedMs as number,
  };
  if (
    observation.threadCount > 4096 ||
    observation.queriedThreads > observation.threadCount ||
    observation.suspendedThreads > observation.queriedThreads ||
    observation.queryFailures > 4097 ||
    observation.minimumSuspendCount > 127 ||
    observation.elapsedMs > 60000
  )
    throw invalid();
  return observation;
}
export function windowsFreezeConfirmed(observation: WindowsFreezeObservation) {
  return (
    observation.suspended &&
    observation.threadSetStable &&
    !observation.timedOut &&
    observation.threadCount > 0 &&
    observation.queriedThreads === observation.threadCount &&
    observation.suspendedThreads === observation.threadCount &&
    observation.queryFailures === 0 &&
    observation.minimumSuspendCount > 0
  );
}

/** Read-only ThreadSuspendCount queries: scheduler wait reasons can describe
 * an outstanding kernel wait even when user-mode execution is suspended. */
export function windowsFreezeSupervisorSource(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("Windows freeze requires an owned process id.");
  return String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class F5ProcessFreeze {
  [DllImport("ntdll.dll")] static extern int NtSuspendProcess(IntPtr handle);
  [DllImport("ntdll.dll")] static extern int NtResumeProcess(IntPtr handle);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationThread(IntPtr handle, int informationClass, out uint count, uint length, out uint returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenThread(uint access, bool inherit, uint id);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetProcessIdOfThread(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static readonly object gate = new object();
  // WDK THREADINFOCLASS.ThreadSuspendCount; supported by the target Windows builds.
  const int ThreadSuspendCount = 35;

  static HashSet<int> ThreadIds(Process target) {
    target.Refresh();
    var ids = new HashSet<int>();
    foreach (ProcessThread thread in target.Threads) {
      using (thread) {
        if (ids.Count >= 4096 || !ids.Add(thread.Id)) throw new Exception("Thread bound");
      }
    }
    return ids;
  }
  static string Observe(Process target, Func<bool> isSuspended) {
    var clock = Stopwatch.StartNew();
    int threads = 0, queried = 0, positive = 0, failures = 0;
    uint minimum = 127;
    bool before = isSuspended(), stable = false;
    var handles = new List<IntPtr>();
    try {
      var ids = ThreadIds(target);
      threads = ids.Count;
      foreach (int id in ids) {
        if (clock.ElapsedMilliseconds >= 200 || !isSuspended()) break;
        // Query rights only: verification never adds or removes a suspend count.
        IntPtr thread = OpenThread(0x0040 | 0x0800, false, (uint)id);
        if (thread == IntPtr.Zero) { failures++; continue; }
        // Retain all handles through the second snapshot to prevent TID reuse.
        handles.Add(thread);
        uint count, returned;
        if (target.HasExited || GetProcessIdOfThread(thread) != (uint)target.Id ||
            NtQueryInformationThread(thread, ThreadSuspendCount, out count, 4, out returned) != 0 ||
            returned != 4 || count > 127) {
          failures++;
          continue;
        }
        queried++;
        minimum = Math.Min(minimum, count);
        if (count > 0) positive++;
      }
      stable = ids.SetEquals(ThreadIds(target)) && !target.HasExited;
    } catch { failures++; }
    finally { foreach (IntPtr thread in handles) CloseHandle(thread); }
    bool suspended = before && isSuspended();
    bool timedOut = clock.ElapsedMilliseconds >= 200;
    if (queried == 0) minimum = 0;
    return "{\"suspended\":" + (suspended ? "true" : "false") +
      ",\"threadCount\":" + threads + ",\"queriedThreads\":" + queried +
      ",\"suspendedThreads\":" + positive + ",\"queryFailures\":" + failures +
      ",\"minimumSuspendCount\":" + minimum +
      ",\"threadSetStable\":" + (stable ? "true" : "false") +
      ",\"timedOut\":" + (timedOut ? "true" : "false") +
      ",\"elapsedMs\":" + clock.ElapsedMilliseconds + "}";
  }
  public static void Run(int pid) {
    using (var target = Process.GetProcessById(pid)) {
      if (target.SessionId != Process.GetCurrentProcess().SessionId) throw new Exception("Different session");
      IntPtr handle = target.Handle;
      bool suspended = false;
      long generation = 0;
      Timer timer = null;
      Action<long> resume = expected => {
        lock(gate) {
          if (suspended && generation == expected) {
            if (NtResumeProcess(handle) != 0) throw new Exception("Resume failed");
            suspended = false;
          }
        }
      };
      Func<bool> isSuspended = () => { lock(gate) { return suspended; } };
      Console.WriteLine("READY"); Console.Out.Flush();
      try {
        string command;
        while ((command = Console.ReadLine()) != null) {
          // Thread enumeration must never hold the independent resume timer's gate.
          if (command == "STATUS") {
            Console.WriteLine(Observe(target, isSuspended));
            Console.Out.Flush();
            continue;
          }
          lock(gate) {
            if (command.StartsWith("SUSPEND ")) {
              int duration = Int32.Parse(command.Substring(8));
              if (duration < 100 || duration > 15000 || suspended) throw new Exception("Invalid freeze");
              if (target.HasExited || NtSuspendProcess(handle) != 0) throw new Exception("Suspend failed");
              suspended = true;
              long token = ++generation;
              if (timer != null) timer.Dispose();
              timer = new Timer(_ => { try { resume(token); } catch { Environment.Exit(2); } }, null, duration, Timeout.Infinite);
              Console.WriteLine("SUSPENDED");
            } else if (command == "RESUME") {
              resume(generation); if (timer != null) timer.Dispose(); timer = null;
              Console.WriteLine("RESUMED");
            } else throw new Exception("Invalid command");
            Console.Out.Flush();
          }
        }
      } finally { resume(generation); if (timer != null) timer.Dispose(); }
    }
  }
}
'@
[F5ProcessFreeze]::Run(TARGET_PID)
`.replace("TARGET_PID", String(pid));
}

/** Supervises an owned rehearsal process. Its independent timer resumes F5 even
 * if the renderer, main process or Node runner stops responding. */
export async function createWindowsProcessFreeze(pid: number) {
  if (process.platform !== "win32" || !Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("Windows freeze requires an owned process id.");
  const source = windowsFreezeSupervisorSource(pid);
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(source, "utf16le").toString("base64"),
    ],
    { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
  );
  const lines = createInterface({ input: child.stdout });
  let observation: WindowsFreezeObservation | undefined;
  let pending: { done: (line: string) => void; fail: (error: Error) => void } | undefined;
  let exited = false;
  const closed = new Promise<void>((done) =>
    child.once("close", () => {
      exited = true;
      pending?.fail(new Error("Freeze supervisor exited"));
      done();
    }),
  );
  const reply = (timeoutMs = 2000) =>
    new Promise<string>((done, fail) => {
      const timer = setTimeout(() => {
        pending = undefined;
        fail(new Error("Freeze supervisor timed out"));
      }, timeoutMs);
      pending = {
        done: (line) => {
          clearTimeout(timer);
          pending = undefined;
          done(line);
        },
        fail: (error) => {
          clearTimeout(timer);
          pending = undefined;
          fail(error);
        },
      };
    });
  lines.on("line", (line) => pending?.done(line));
  child.once("error", () => pending?.fail(new Error("Freeze supervisor failed")));
  child.stdin.on("error", () => pending?.fail(new Error("Freeze supervisor disconnected")));
  const command = (text: string) => {
    const result = reply();
    child.stdin.write(text + "\n");
    return result;
  };
  try {
    if ((await reply(15000)) !== "READY") throw new Error("Freeze supervisor not ready");
  } catch (error) {
    child.stdin.end();
    throw error;
  }
  return {
    async freeze(durationMs: number) {
      if (!Number.isInteger(durationMs) || durationMs < 100 || durationMs > 15000)
        throw new Error("Invalid freeze duration");
      if ((await command("SUSPEND " + durationMs)) !== "SUSPENDED")
        throw new Error("Process did not suspend");
    },
    async stopped() {
      observation = decodeWindowsFreezeObservation(JSON.parse(await command("STATUS")));
      return windowsFreezeConfirmed(observation);
    },
    observation: () => observation,
    async resume() {
      if (!exited && (await command("RESUME")) !== "RESUMED")
        throw new Error("Process did not resume");
    },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => {
        if (!exited) child.kill();
      }, 16000);
      try {
        await closed;
      } finally {
        clearTimeout(timer);
        lines.close();
      }
    },
  };
}
