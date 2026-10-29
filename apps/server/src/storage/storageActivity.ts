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
export type StorageActivitySnapshot =
  | { readonly processes: ReadonlyArray<StorageProcess> }
  | { readonly error: string };
export async function captureStorageActivity(): Promise<StorageActivitySnapshot> {
  try {
    return { processes: await readStorageProcesses() };
  } catch {
    return { error: "Process activity could not be verified. Close applications and rescan." };
  }
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
        /^(?:google[- ]chrome(?: helper(?: \([^)]+\))?)?|chrome(?:\.exe)?|chromium(?:-browser)?)$/i.test(
          process.name,
        )) ||
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
export async function inspectStorageActivity(
  path: string,
  snapshot?: StorageActivitySnapshot,
): Promise<StorageActivity> {
  try {
    if (snapshot && "error" in snapshot) return { state: "unknown", reason: snapshot.error };
    const canonical = await FS.realpath(path);
    if (!snapshot)
      inspection ??= readStorageProcesses().finally(() => {
        inspection = undefined;
      });
    const activity = activityForTarget(canonical, snapshot?.processes ?? (await inspection!));
    // Review uses one process snapshot. Deletion freshly checks file sharing too.
    if (activity.state !== "idle" || process.platform !== "win32" || snapshot) return activity;
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
  if (!paths.length) return { state: "idle" };
  try {
    const { WINDOWS_STORAGE_FILE_PROBE } = await import("./windowsStorageProbe.ts");
    const result = await runProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_STORAGE_FILE_PROBE],
      {
        env: process.env,
        stdin: JSON.stringify(paths),
        timeoutMs: Math.min(120_000, 15_000 + paths.length * 2),
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
  } catch (error) {
    return {
      state: "unknown",
      reason:
        "Windows file-use inspection is unavailable. Close applications and rescan. " +
        (error instanceof Error ? error.message.slice(-400) : ""),
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
export function linuxMappedPaths(maps: string): string[] {
  return maps.split("\n").flatMap((line) => {
    const path = line.match(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/)?.[1];
    return path
      ? [
          path
            .replace(/ \(deleted\)$/, "")
            .replace(/\\([0-7]{3})/g, (_, octal: string) =>
              String.fromCharCode(parseInt(octal, 8)),
            ),
        ]
      : [];
  });
}
export async function readStorageProcesses(
  platform = process.platform,
  procRoot = "/proc",
): Promise<StorageProcess[]> {
  if (platform === "darwin") {
    const result = await runProcess("lsof", ["-n", "-P", "-Fpcfn"], {
      env: process.env,
      timeoutMs: 10_000,
      maxBufferBytes: 64 * 1024 * 1024,
      outputMode: "error",
    });
    if (result.signal) throw new Error("Process inspection interrupted.");
    return parseLsofProcesses(result.stdout);
  }
  if (platform === "linux") {
    const result: StorageProcess[] = [];
    for (const entry of await FS.readdir(procRoot, { withFileTypes: true })) {
      if (!/^\d+$/.test(entry.name)) continue;
      const root = Path.join(procRoot, entry.name);
      try {
        const stat = await FS.stat(root);
        if (typeof process.getuid === "function" && stat.uid !== process.getuid()) continue;
        const [name, cwd, executable, maps, descriptors] = await Promise.all([
          FS.readFile(Path.join(root, "comm"), "utf8").catch(() => "Process"),
          FS.readlink(Path.join(root, "cwd")).catch(() => undefined),
          FS.readlink(Path.join(root, "exe")).catch(() => undefined),
          FS.readFile(Path.join(root, "maps"), "utf8").catch(() => ""),
          FS.readdir(Path.join(root, "fd")).catch(() => []),
        ]);
        const paths = await Promise.all(
          descriptors.map((fd) =>
            FS.readlink(Path.join(root, "fd", fd)).catch((error: NodeJS.ErrnoException) => {
              // Exited, kernel and protected processes do not invalidate the
              // readable executable/mapping/handle evidence of other processes.
              if (["ENOENT", "EACCES", "EPERM", "ESRCH"].includes(error.code ?? "")) return "";
              throw error;
            }),
          ),
        );
        result.push({
          pid: Number(entry.name),
          name: name.trim(),
          ...(cwd ? { cwd } : {}),
          paths: [...paths, ...(executable ? [executable] : []), ...linuxMappedPaths(maps)]
            .filter((p) => p.startsWith("/"))
            .map((p) => p.replace(/ \(deleted\)$/, "")),
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
    // PEB paths may use DOS short names while target realpaths use long names.
    // Normalize both before containment checks.
    const canonical = async (path: string) => FS.realpath(path).catch(() => path);
    const processes: StorageProcess[] = [];
    for (const item of parsed)
      processes.push({
        ...item,
        cwd: item.cwd ? await canonical(item.cwd) : undefined,
        paths: await Promise.all(item.paths.map(canonical)),
      });
    return processes;
  }
  throw new Error("Storage activity inspection is unavailable on this platform.");
}
