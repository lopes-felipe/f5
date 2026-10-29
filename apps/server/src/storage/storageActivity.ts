import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { runProcess } from "../processRunner.ts";
import { enumerateFiles } from "./diskUsage.ts";

export type StorageActivity =
  | { readonly state: "idle" }
  | { readonly state: "busy" | "unknown"; readonly reason: string };
export interface StorageProcess {
  readonly pid: number;
  readonly name: string;
  readonly cwd?: string;
  readonly paths: ReadonlyArray<string>;
}
const contains = (root: string, target: string) => {
  const relative = Path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !Path.isAbsolute(relative));
};
export function activityForTarget(
  target: string,
  processes: ReadonlyArray<StorageProcess>,
  application?: "chrome" | "bambu",
): StorageActivity {
  for (const process of processes) {
    if (
      (application === "chrome" &&
        /(?:google[- ]chrome|chrome(?:\.exe)?$|chromium)/i.test(process.name)) ||
      (application === "bambu" && /bambu/i.test(process.name)) ||
      (process.cwd && contains(target, process.cwd)) ||
      process.paths.some(
        (path) =>
          contains(target, path) &&
          !(
            process.name === "Electron" &&
            process.cwd &&
            !contains(target, process.cwd) &&
            path.endsWith("/Contents/Resources/default_app.asar")
          ),
      )
    )
      return {
        state: "busy",
        reason: process.name + " is using this storage. Close it and rescan.",
      };
  }
  return { state: "idle" };
}
let inspection: Promise<StorageProcess[]> | undefined;
/** Coalesce simultaneous scans; never reuse an old process snapshot for deletion. */
export async function inspectStorageActivity(path: string): Promise<StorageActivity> {
  try {
    const canonical = await FS.realpath(path);
    inspection ??= readStorageProcesses().finally(() => {
      inspection = undefined;
    });
    const activity = activityForTarget(canonical, await inspection);
    if (activity.state !== "idle" || process.platform !== "win32") return activity;
    const files = await enumerateFiles(path);
    if (files.errors.length)
      return { state: "unknown", reason: "Files could not be inspected for active use." };
    return inspectWindowsFileUse(files.files.map((file) => file.path));
  } catch {
    return {
      state: "unknown",
      reason:
        "Process activity could not be verified. Close applications using this checkout and rescan.",
    };
  }
}
export async function inspectWindowsFileUse(paths: string[]): Promise<StorageActivity> {
  try {
    const { WINDOWS_STORAGE_FILE_PROBE } = await import("./windowsStorageProbe.ts");
    const result = await runProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_STORAGE_FILE_PROBE],
      {
        env: process.env,
        stdin: JSON.stringify(paths),
        timeoutMs: 15_000,
        maxBufferBytes: 1024 * 1024,
        outputMode: "error",
      },
    );
    const busy: unknown = JSON.parse(result.stdout);
    if (typeof busy !== "boolean" || result.signal)
      throw new Error("Invalid file-use inspection response.");
    return busy
      ? { state: "busy", reason: "An application has files open here. Close it and rescan." }
      : { state: "idle" };
  } catch {
    return {
      state: "unknown",
      reason: "Windows file-use inspection is unavailable. Close applications and rescan.",
    };
  }
}
export function parseLsofProcesses(output: string): StorageProcess[] {
  const result: Array<{ pid: number; name: string; cwd?: string; paths: string[] }> = [];
  let process: (typeof result)[number] | undefined;
  let fd = "";
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const pid = Number(line.slice(1));
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new Error("Invalid process inspection output.");
      process = { pid, name: "Process", paths: [] };
      result.push(process);
    } else if (line.startsWith("c") && process) process.name = line.slice(1);
    else if (line.startsWith("f")) fd = line.slice(1);
    else if (line.startsWith("n/") && process) {
      const path = line.slice(1).replace(/ \(deleted\)$/, "");
      if (fd === "cwd") process.cwd = path;
      else process.paths.push(path);
    }
  }
  if (!result.length) throw new Error("Process inspection returned no processes.");
  return result;
}

/** No process is stopped. Failure to inspect is never interpreted as inactivity. */
export async function readStorageProcesses(platform = process.platform): Promise<StorageProcess[]> {
  if (platform === "darwin") {
    const result = await runProcess("lsof", ["-n", "-P", "-Fpcfn"], {
      env: process.env,
      timeoutMs: 10_000,
      maxBufferBytes: 16 * 1024 * 1024,
      outputMode: "error",
    });
    if (result.signal) throw new Error("Process inspection interrupted.");
    return parseLsofProcesses(result.stdout);
  }
  if (platform === "linux") {
    const result: StorageProcess[] = [];
    for (const entry of await FS.readdir("/proc", { withFileTypes: true })) {
      if (!/^\d+$/.test(entry.name)) continue;
      const root = Path.join("/proc", entry.name);
      try {
        const stat = await FS.stat(root);
        if (typeof process.getuid === "function" && stat.uid !== process.getuid()) continue;
        const [name, cwd, descriptors] = await Promise.all([
          FS.readFile(Path.join(root, "comm"), "utf8"),
          FS.readlink(Path.join(root, "cwd")),
          FS.readdir(Path.join(root, "fd")),
        ]);
        const paths = await Promise.all(
          descriptors.map((fd) =>
            FS.readlink(Path.join(root, "fd", fd)).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return "";
              throw error;
            }),
          ),
        );
        result.push({
          pid: Number(entry.name),
          name: name.trim(),
          cwd,
          paths: paths.filter((p) => p.startsWith("/")),
        });
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" &&
          (error as NodeJS.ErrnoException).code !== "ESRCH"
        )
          throw error;
      }
    }
    if (!result.length) throw new Error("Process inspection returned no processes.");
    return result;
  }
  if (platform === "win32") {
    const { WINDOWS_STORAGE_PROBE } = await import("./windowsStorageProbe.ts");
    const result = await runProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_STORAGE_PROBE],
      {
        env: process.env,
        timeoutMs: 15_000,
        maxBufferBytes: 4 * 1024 * 1024,
        outputMode: "error",
      },
    );
    if (result.signal) throw new Error("Process inspection interrupted.");
    const parsed: unknown = JSON.parse(result.stdout);
    if (
      !Array.isArray(parsed) ||
      !parsed.length ||
      !parsed.every(
        (p) =>
          p &&
          Number.isSafeInteger(p.pid) &&
          typeof p.name === "string" &&
          Array.isArray(p.paths) &&
          p.paths.every((path: unknown) => typeof path === "string") &&
          (p.cwd === null || typeof p.cwd === "string"),
      )
    )
      throw new Error("Invalid Windows process inspection response.");
    return parsed.map((p) => ({ ...p, cwd: p.cwd ?? undefined }));
  }
  throw new Error("Storage activity inspection is unavailable on this platform.");
}
