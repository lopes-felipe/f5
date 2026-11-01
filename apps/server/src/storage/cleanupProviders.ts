import * as FS from "node:fs/promises";
import * as Path from "node:path";
import * as OS from "node:os";
import type {
  StorageCleanupCategoryId,
  StorageCleanupCategoryUsage,
  StoragePathWarning,
  StorageDiscoverySettings,
} from "@t3tools/contracts";
import { runStorageTask, type StorageFileInspection } from "./storageWorker.ts";
import { type FileIdentity } from "./diskUsage.ts";

export const MACHINE_CATEGORY_IDS: ReadonlySet<StorageCleanupCategoryId> = new Set([
  "f5Backups",
  "f5ApplicationLogs",
  "bunDownloadCache",
  "npmDownloadCache",
  "uvDiscardedCaches",
  "chromeCaches",
  "bambuStudioLogs",
]);
export interface CleanupFileReview {
  providerId: StorageCleanupCategoryId;
  path: string;
  allowedRoot: string;
  identity: FileIdentity;
  fingerprint: string;
  application?: "chrome" | "bambu";
}
interface Provider {
  id: StorageCleanupCategoryId;
  title: string;
  description: string;
  roots: string[];
  application?: "chrome" | "bambu";
  files?: (name: string, mtimeMs: number) => boolean;
  children?: RegExp;
}
/** Platform/config resolution is kept separate from scanning and deletion. */
export function cleanupProviders(input: {
  stateDirs: string[];
  enabled: boolean;
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  now?: number;
}): Provider[] {
  const home = input.home ?? OS.homedir(),
    platform = input.platform ?? process.platform,
    env = input.env ?? process.env;
  const paths = platform === "win32" ? Path.win32 : Path.posix;
  const join = paths.join;
  const cache =
    platform === "win32"
      ? (env.LOCALAPPDATA ?? join(home, "AppData", "Local"))
      : platform === "darwin"
        ? join(home, "Library", "Caches")
        : (env.XDG_CACHE_HOME ?? join(home, ".cache"));
  const config =
    platform === "win32"
      ? (env.APPDATA ?? join(home, "AppData", "Roaming"))
      : platform === "darwin"
        ? join(home, "Library", "Application Support")
        : (env.XDG_CONFIG_HOME ?? join(home, ".config"));
  const old = (mtime: number) => mtime < (input.now ?? Date.now()) - 7 * 86400_000;
  const result: Provider[] = [
    {
      id: "f5Backups",
      title: "F5 recovery backups",
      description:
        "Permanently removes selected recovery copies. Deleting the last backup removes that recovery option.",
      roots: input.stateDirs.map((p) => join(p, "backups")),
      files: (name) =>
        /^(?:state-before-[\w.-]+\.sqlite|daily-\d{13}-[a-f0-9-]{36}\.f5backup)$/.test(name),
    },
    {
      id: "f5ApplicationLogs",
      title: "Old F5 application logs",
      description:
        "Application log rotations older than seven days. Conversation/provider logs are protected by their own retention rules.",
      roots: input.stateDirs.map((p) => join(p, "logs")),
      files: (name, mtime) =>
        /^(?:desktop-main|server|server-child)\.log\.\d+$/.test(name) && old(mtime),
    },
  ];
  if (!input.enabled) return result;
  result.push(
    {
      id: "bunDownloadCache",
      title: "Bun download cache",
      description:
        "Downloaded packages are fetched again when needed. Installed project dependencies are retained.",
      roots: [
        env.BUN_INSTALL_CACHE_DIR ??
          join(env.BUN_INSTALL ?? join(home, ".bun"), "install", "cache"),
      ],
    },
    {
      id: "npmDownloadCache",
      title: "npm download cache",
      description: "Downloaded packages are fetched again when needed.",
      roots: [
        join(
          env.npm_config_cache ??
            env.NPM_CONFIG_CACHE ??
            (platform === "win32" ? join(cache, "npm-cache") : join(home, ".npm")),
          "_cacache",
        ),
      ],
    },
    {
      id: "uvDiscardedCaches",
      title: "Discarded uv caches",
      description:
        "Discarded cache directories older than seven days; active environments and uv's current cache are retained.",
      roots: [
        paths.dirname(
          env.UV_CACHE_DIR ??
            (platform === "win32"
              ? join(cache, "uv")
              : join(env.XDG_CACHE_HOME ?? join(home, ".cache"), "uv")),
        ),
      ],
      children: /^uv\.trash-[\w.-]+$/,
    },
    {
      id: "bambuStudioLogs",
      title: "Old BambuStudio logs",
      description: "Logs older than seven days. Close BambuStudio before cleanup.",
      roots: [join(config, "BambuStudio", "log")],
      application: "bambu",
      files: (_name, mtime) => old(mtime),
    },
  );
  const chromeRoot =
    platform === "win32"
      ? join(cache, "Google", "Chrome", "User Data")
      : platform === "darwin"
        ? join(cache, "Google", "Chrome")
        : join(cache, "google-chrome");
  // User Data may be a discovery boundary; only its profile cache children are targets.
  result.push({
    id: "chromeCaches",
    title: "Chrome caches",
    description:
      "Browser cache only; history, cookies, passwords and profiles remain. Close Chrome before cleanup.",
    roots: [chromeRoot],
    children: /^(?:Default|Profile \d+)$/,
    application: "chrome",
  });
  return result;
}

/** Runs in the maintenance child so even root directory reads have a time bound. */
export async function discoverProviderCandidates(id: StorageCleanupCategoryId, root: string) {
  const provider = cleanupProviders({ stateDirs: [], enabled: true }).find((p) => p.id === id);
  if (!provider) throw new Error("Unknown cleanup provider.");
  if (id === "bunDownloadCache") {
    const candidates: string[] = [];
    const stat = await FS.lstat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat?.isDirectory() && !stat.isSymbolicLink()) candidates.push(root);
    for (const entry of await FS.readdir(Path.dirname(root), { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    ))
      if (
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        /^\.f5-bun-cache-trash-[a-f0-9-]{36}$/.test(entry.name)
      )
        candidates.push(Path.join(Path.dirname(root), entry.name));
    return candidates;
  }
  const stat = await FS.lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Cleanup root is not a real directory.");
  const candidates: string[] = [];
  if (provider.files || provider.children) {
    for (const entry of await FS.readdir(root, { withFileTypes: true })) {
      const path = Path.join(root, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (
        provider.files &&
        entry.isFile() &&
        provider.files(entry.name, (await FS.lstat(path)).mtimeMs)
      )
        candidates.push(path);
      if (provider.children?.test(entry.name) && entry.isDirectory()) {
        if (provider.id === "chromeCaches") {
          for (const name of ["Cache", "Code Cache", "GPUCache"]) {
            const cache = await FS.lstat(Path.join(path, name)).catch(() => null);
            if (cache?.isDirectory() && !cache.isSymbolicLink())
              candidates.push(Path.join(path, name));
          }
        } else if ((await FS.lstat(path)).mtimeMs < Date.now() - 7 * 86400_000)
          candidates.push(path);
      }
    }
  } else candidates.push(root);
  return candidates;
}

export async function scanCleanupProviders(input: {
  stateDirs: string[];
  settings: StorageDiscoverySettings;
  signal?: AbortSignal;
}) {
  const categories: StorageCleanupCategoryUsage[] = [],
    reviews = new Map<string, CleanupFileReview>();
  for (const provider of cleanupProviders({
    stateDirs: input.stateDirs,
    enabled: input.settings.machineCleanupEnabled,
  })) {
    const targets: StorageCleanupCategoryUsage["targets"][number][] = [],
      warnings: StoragePathWarning[] = [];
    for (const root of new Set(provider.roots)) {
      input.signal?.throwIfAborted();
      try {
        const candidates = await runStorageTask<string[]>(
          { kind: "providerCandidates", providerId: provider.id, root },
          input.signal,
        );
        if (!candidates.length) continue;
        const inspections = await runStorageTask<
          Array<{ path: string; inspection?: StorageFileInspection; error?: string }>
        >(
          {
            kind: "inspectBatch",
            items: candidates.map((path) => ({
              path,
              ...(provider.application ? { application: provider.application } : {}),
            })),
          },
          input.signal,
        ).catch((error: unknown) =>
          candidates.map((path) => ({ path, error: String(error), inspection: undefined })),
        );
        for (const path of candidates) {
          let inspection: StorageFileInspection;
          try {
            const reviewed = inspections.find((entry) => entry.path === path);
            if (!reviewed?.inspection)
              throw new Error(reviewed?.error ?? "Inspection unavailable.");
            inspection = reviewed.inspection;
          } catch (error) {
            targets.push({
              id: path,
              path,
              label: Path.basename(path),
              bytes: 0,
              safeToDelete: false,
              disabledReason: String(error),
              blockingReasons: [{ code: "inspection_unavailable", message: String(error) }],
            });
            continue;
          }
          const safeToDelete =
            inspection.activity.state === "idle" &&
            !!inspection.identity &&
            !!inspection.fingerprint;
          const disabledReason =
            inspection.activity.state === "idle" ? undefined : inspection.activity.reason;
          if (inspection.identity && inspection.fingerprint)
            reviews.set(path, {
              providerId: provider.id,
              path,
              allowedRoot:
                provider.id === "bunDownloadCache" || root === path ? Path.dirname(root) : root,
              identity: inspection.identity,
              fingerprint: inspection.fingerprint,
              ...(provider.application ? { application: provider.application } : {}),
            });
          targets.push({
            id: path,
            path,
            label: Path.basename(path),
            bytes: inspection.bytes ?? 0,
            safeToDelete,
            latestMtime: inspection.identity
              ? new Date(inspection.identity.mtimeMs).toISOString()
              : undefined,
            ...(disabledReason
              ? {
                  disabledReason,
                  blockingReasons: [{ code: "storage_in_use", message: disabledReason }],
                }
              : {}),
            detail:
              provider.id === "f5Backups"
                ? (candidates.length === 1
                    ? "Last recovery copy in this folder · "
                    : "Recovery copy · ") +
                  Math.max(
                    0,
                    Math.floor(
                      (Date.now() - (inspection.identity?.mtimeMs ?? Date.now())) / 86400_000,
                    ),
                  ) +
                  " days old · " +
                  root
                : provider.description,
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          warnings.push({ path: root, reason: String(error) });
      }
    }
    categories.push({
      id: provider.id,
      section:
        provider.id === "f5Backups"
          ? "database"
          : provider.id === "f5ApplicationLogs"
            ? "logs"
            : "machine",
      title: provider.title,
      description: provider.description,
      bytes: targets.reduce((n, t) => n + t.bytes, 0),
      reclaimableBytes: targets.filter((t) => t.safeToDelete).reduce((n, t) => n + t.bytes, 0),
      measurement:
        warnings.length ||
        targets.some((t) => t.blockingReasons?.some((r) => r.code === "inspection_unavailable"))
          ? targets.some((t) => t.bytes > 0)
            ? "partial"
            : "unavailable"
          : "complete",
      eligibleThreadCount: 0,
      defaultSelected: false,
      impact: provider.id === "f5Backups" ? "high" : "low",
      availability: targets.length ? "ready" : "disabled",
      ...(!targets.length
        ? {
            disabledReason: warnings.length
              ? "Inspection unavailable. Check folder access and rescan."
              : "No cleanup candidates found.",
          }
        : {}),
      targetCount: targets.length,
      targets,
      warnings,
    });
  }
  return { categories, reviews };
}
