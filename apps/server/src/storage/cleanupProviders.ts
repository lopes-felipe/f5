import * as FS from "node:fs/promises";
import * as Path from "node:path";
import * as OS from "node:os";
import type {
  StorageCleanupCategoryId,
  StorageCleanupCategoryUsage,
  StorageCleanupImpact,
  StoragePathWarning,
  StorageDiscoverySettings,
} from "@t3tools/contracts";
import { formatByteSize } from "@t3tools/shared/byteSize";
import {
  DATABASE_SNAPSHOT_NAME,
  isDatabaseSnapshotName,
  listDatabaseSnapshots,
} from "../persistence/databaseFiles.ts";
import { runStorageTask, type StorageFileInspection } from "./storageWorker.ts";
import { type FileIdentity } from "./diskUsage.ts";
import {
  readSnapshotUsageCache,
  writeSnapshotUsageCache,
  type SnapshotUsageCacheEntry,
  type SnapshotUsageResult,
} from "./snapshotUsage.ts";

/** Categories scanned by {@link cleanupProviders} and removed through reviewed file deletion. */
export const MACHINE_CATEGORY_IDS: ReadonlySet<StorageCleanupCategoryId> = new Set([
  "f5Backups",
  "f5ApplicationLogs",
  "f5UpdaterCache",
  "claudePluginTrash",
  "bunDownloadCache",
  "npmDownloadCache",
  "uvDiscardedCaches",
  "chromeCaches",
  "bambuStudioLogs",
  "devboxWarmupCache",
  "playwrightBrowsers",
  "electronDownloadCache",
  "nodeGypCache",
]);
const DAY_MS = 86400_000;
export interface CleanupFileReview {
  providerId: StorageCleanupCategoryId;
  path: string;
  allowedRoot: string;
  identity: FileIdentity;
  fingerprint: string;
  application?: "chrome" | "bambu";
  /**
   * What removing the target frees, when that is less than the size of its
   * files: a database snapshot shares most of its blocks with newer copies.
   */
  reclaimBytes?: number;
}
interface Provider {
  id: StorageCleanupCategoryId;
  title: string;
  description: string;
  roots: string[];
  section: Extract<
    StorageCleanupCategoryUsage["section"],
    "database" | "logs" | "providers" | "machine"
  >;
  impact: StorageCleanupImpact;
  application?: "chrome" | "bambu";
  files?: (name: string, mtimeMs: number) => boolean;
  children?: RegExp;
  /** Matching children must be older than this; seven days unless set. */
  childMinAgeMs?: (name: string) => number;
  /** Never offer the newest database snapshot among the children for deletion. */
  keepNewestSnapshot?: boolean;
}
/**
 * Whether a reviewed path may be removed without machine cleanup enabled:
 * F5's own data, including the F5 Claude provider home.
 */
export function isUngatedProviderTarget(input: {
  categoryId: StorageCleanupCategoryId;
  path: string;
  providerHomesDir?: string;
}): boolean {
  if (
    input.categoryId === "f5Backups" ||
    input.categoryId === "f5ApplicationLogs" ||
    input.categoryId === "f5UpdaterCache"
  )
    return true;
  if (input.categoryId !== "claudePluginTrash" || !input.providerHomesDir) return false;
  const relative = Path.relative(input.providerHomesDir, input.path);
  return relative !== "" && !relative.startsWith("..") && !Path.isAbsolute(relative);
}
/** Platform/config resolution is kept separate from scanning and deletion. */
export function cleanupProviders(input: {
  stateDirs: string[];
  enabled: boolean;
  /** F5's provider homes; the Claude home's plugin trash is always offered. */
  providerHomesDir?: string;
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
  const now = input.now ?? Date.now();
  const old = (mtime: number) => mtime < now - 7 * DAY_MS;
  const claudeTrash = (configDir: string) => join(configDir, "plugins", ".trash");
  const providerClaudeTrash = input.providerHomesDir
    ? claudeTrash(join(input.providerHomesDir, "claude", ".claude"))
    : null;
  const result: Provider[] = [
    {
      id: "f5Backups",
      title: "F5 recovery backups",
      description:
        "Permanently removes selected recovery copies. Deleting the last backup removes that recovery option.",
      roots: input.stateDirs.map((p) => join(p, "backups")),
      section: "database",
      impact: "high",
      files: (name) =>
        /^(?:state-before-[\w.-]+\.sqlite|daily-\d{13}-[a-f0-9-]{36}\.f5backup)$/.test(name),
      // Automatic database snapshots; storage/databaseSnapshots.ts prunes them itself.
      // The newest one is the copy most likely to be needed, so it is never offered.
      children: DATABASE_SNAPSHOT_NAME,
      childMinAgeMs: () => 0,
      keepNewestSnapshot: true,
    },
    {
      id: "f5ApplicationLogs",
      title: "Old F5 application logs",
      description:
        "Application log rotations older than seven days. Conversation/provider logs are protected by their own retention rules.",
      roots: input.stateDirs.map((p) => join(p, "logs")),
      section: "logs",
      impact: "low",
      files: (name, mtime) =>
        /^(?:desktop-main|server|server-child)\.log\.\d+$/.test(name) && old(mtime),
    },
    {
      id: "f5UpdaterCache",
      title: "F5 update downloads",
      description:
        "Downloaded F5 update packages older than a day. A downloaded update waiting for a restart is kept for seven days; later updates download in full.",
      roots: [join(cache, "f5-desktop-updater")],
      section: "machine",
      impact: "low",
      files: (_name, mtime) => mtime < now - DAY_MS,
      children: /^[^.]/,
      childMinAgeMs: (name) => (name === "pending" ? 7 * DAY_MS : DAY_MS),
    },
  ];
  const claudeTrashRoots = [
    ...(providerClaudeTrash ? [providerClaudeTrash] : []),
    ...(input.enabled ? [claudeTrash(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"))] : []),
  ];
  if (claudeTrashRoots.length)
    result.push({
      id: "claudePluginTrash",
      title: "Claude plugin trash",
      description:
        "Plugin versions Claude moved to its plugins trash more than a day ago. Installed plugins are retained.",
      roots: [...new Set(claudeTrashRoots)],
      section: "providers",
      impact: "none",
      children: /^[^.]/,
      childMinAgeMs: () => DAY_MS,
    });
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
      section: "machine",
      impact: "low",
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
      section: "machine",
      impact: "low",
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
      section: "machine",
      impact: "low",
      children: /^uv\.trash-[\w.-]+$/,
    },
    {
      id: "bambuStudioLogs",
      title: "Old BambuStudio logs",
      description: "Logs older than seven days. Close BambuStudio before cleanup.",
      roots: [join(config, "BambuStudio", "log")],
      section: "machine",
      impact: "low",
      application: "bambu",
      files: (_name, mtime) => old(mtime),
    },
    {
      id: "devboxWarmupCache",
      title: "devbox warm-up cache",
      description:
        "Prefetched devbox tool images and IDE backends. devbox downloads them again when it next warms up.",
      roots: [join(home, ".devbox", "warmupcache")],
      section: "machine",
      impact: "low",
      children: /^[^.]/,
      childMinAgeMs: () => DAY_MS,
    },
    {
      id: "playwrightBrowsers",
      title: "Playwright browsers",
      description: "Downloaded browser builds. Re-download with npx playwright install.",
      roots: [
        env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== "0"
          ? env.PLAYWRIGHT_BROWSERS_PATH
          : join(cache, "ms-playwright"),
      ],
      section: "machine",
      impact: "low",
      // Only Playwright's own browser folders, so a mis-set
      // PLAYWRIGHT_BROWSERS_PATH offers nothing else.
      children:
        /^(?:chromium|chromium_headless_shell|chromium-headless-shell|firefox|firefox-beta|webkit|ffmpeg|winldd|android)-\d+$/,
      childMinAgeMs: () => 0,
    },
    {
      id: "electronDownloadCache",
      title: "Electron download cache",
      description: "Downloaded Electron releases. They are fetched again on the next install.",
      roots: [env.ELECTRON_CACHE ?? join(cache, "electron")],
      section: "machine",
      impact: "low",
      // @electron/get's URL-hash folders and older flat downloads only, so a
      // mis-set ELECTRON_CACHE offers nothing else.
      children:
        /^(?:[0-9a-f]{64}|https?github\.com.+|(?:electron|chromedriver|ffmpeg|mksnapshot)-v.+|SHASUMS256\.txt.*)$/,
      childMinAgeMs: () => DAY_MS,
    },
    {
      id: "nodeGypCache",
      title: "node-gyp headers",
      description: "Node.js headers for native addon builds. They are fetched again when needed.",
      roots: [join(cache, "node-gyp")],
      section: "machine",
      impact: "low",
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
    section: "machine",
    impact: "low",
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
        } else {
          if (
            (await FS.lstat(path)).mtimeMs <
            Date.now() - (provider.childMinAgeMs?.(entry.name) ?? 7 * DAY_MS)
          )
            candidates.push(path);
        }
      }
    }
  } else candidates.push(root);
  if (provider.keepNewestSnapshot) {
    // The same rule as everywhere else decides what a snapshot is: a newer
    // directory without a database must not take the protection from the
    // newest real copy, and is itself offered for removal.
    const newest = listDatabaseSnapshots(root)[0]?.path;
    return candidates.filter((path) => path !== newest);
  }
  return candidates;
}

export async function scanCleanupProviders(input: {
  stateDirs: string[];
  providerHomesDir?: string;
  settings: StorageDiscoverySettings;
  /** Keeps snapshot comparison results between scans; snapshots are immutable. */
  snapshotUsageCachePath?: string;
  /** Time for one backups directory's comparisons; the worker's default when unset. */
  snapshotUsageBudgetMs?: number;
  signal?: AbortSignal;
}) {
  const categories: StorageCleanupCategoryUsage[] = [],
    reviews = new Map<string, CleanupFileReview>();
  /**
   * Per backups directory, the bytes its snapshots share with newer copies.
   * A directory walk counts those bytes once per clone.
   */
  const sharedSnapshotBytes = new Map<string, number>();
  let knownSnapshotUsage: ReadonlyArray<SnapshotUsageCacheEntry> = input.snapshotUsageCachePath
    ? await readSnapshotUsageCache(input.snapshotUsageCachePath)
    : [];
  const withinBackupsDir = (directory: string, path: string) =>
    path.startsWith(directory + Path.sep);
  for (const provider of cleanupProviders({
    stateDirs: input.stateDirs,
    enabled: input.settings.machineCleanupEnabled,
    ...(input.providerHomesDir ? { providerHomesDir: input.providerHomesDir } : {}),
  })) {
    const targets: StorageCleanupCategoryUsage["targets"][number][] = [],
      warnings: StoragePathWarning[] = [];
    let snapshotEstimateMissing = false;
    for (const root of new Set(provider.roots)) {
      input.signal?.throwIfAborted();
      try {
        const candidates = await runStorageTask<string[]>(
          { kind: "providerCandidates", providerId: provider.id, root },
          input.signal,
        );
        // The newest snapshot is never a candidate, but it is still a clone
        // that a directory walk counts in full, so compare even without candidates.
        let snapshotUsage: SnapshotUsageResult | null = null;
        if (provider.id === "f5Backups") {
          const known = knownSnapshotUsage.filter((entry) => withinBackupsDir(root, entry.older));
          // Saves a worker start for a profile without snapshots. The worker
          // listed this directory within its time bound a moment ago
          // (providerCandidates above), so this read is not the one that stalls.
          const hasSnapshots = (await FS.readdir(root).catch(() => [] as string[])).some(
            isDatabaseSnapshotName,
          );
          snapshotUsage = hasSnapshots
            ? await runStorageTask<SnapshotUsageResult>(
                {
                  kind: "snapshotUsage",
                  backupsDir: root,
                  liveDbPath: Path.join(Path.dirname(root), "state.sqlite"),
                  cache: known,
                  ...(input.snapshotUsageBudgetMs === undefined
                    ? {}
                    : { budgetMs: input.snapshotUsageBudgetMs }),
                },
                input.signal,
              ).catch(() => null)
            : { entries: [], failed: [], cache: [] };
          input.signal?.throwIfAborted();
          if (snapshotUsage) {
            if (snapshotUsage.entries.length > 0)
              sharedSnapshotBytes.set(
                root,
                snapshotUsage.entries.reduce((sum, entry) => sum + entry.sharedBytes, 0),
              );
            // Store this directory's finished comparisons now: a later
            // provider that is cancelled or fails must not cost them.
            if (
              input.snapshotUsageCachePath &&
              JSON.stringify(known) !== JSON.stringify(snapshotUsage.cache)
            ) {
              knownSnapshotUsage = [
                ...knownSnapshotUsage.filter((entry) => !withinBackupsDir(root, entry.older)),
                ...snapshotUsage.cache,
              ];
              await writeSnapshotUsageCache(input.snapshotUsageCachePath, knownSnapshotUsage).catch(
                () => {},
              );
            }
          }
        }
        if (!candidates.length) continue;
        const oldestSnapshot = [
          ...(snapshotUsage?.entries.map((entry) => entry.path) ?? []),
          ...(snapshotUsage?.failed ?? []),
        ].toSorted()[0];
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
          const isSnapshot =
            provider.id === "f5Backups" && isDatabaseSnapshotName(Path.basename(path));
          const logicalBytes = inspection.bytes ?? 0;
          const sharedBytes = isSnapshot
            ? snapshotUsage?.entries.find((entry) => entry.path === path)?.sharedBytes
            : undefined;
          // An emptied snapshot directory has nothing to compare and nothing to misreport.
          if (isSnapshot && sharedBytes === undefined && logicalBytes > 0)
            snapshotEstimateMissing = true;
          const bytes =
            sharedBytes === undefined ? logicalBytes : Math.max(0, logicalBytes - sharedBytes);
          // The figure counts what the next copy lacks. Part of that can still
          // be held by an older snapshot, so only the oldest frees all of it alone.
          const sharingNote =
            path === oldestSnapshot
              ? "not shared with newer copies"
              : "not shared with newer copies (less is freed while an older snapshot is kept)";
          if (inspection.identity && inspection.fingerprint)
            reviews.set(path, {
              providerId: provider.id,
              path,
              allowedRoot:
                provider.id === "bunDownloadCache" || root === path ? Path.dirname(root) : root,
              identity: inspection.identity,
              fingerprint: inspection.fingerprint,
              ...(provider.application ? { application: provider.application } : {}),
              ...(sharedBytes === undefined ? {} : { reclaimBytes: bytes }),
            });
          targets.push({
            id: path,
            path,
            label: Path.basename(path),
            bytes,
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
                ? (isSnapshot
                    ? sharedBytes === undefined
                      ? "Automatic database snapshot. It shares unchanged data with the live database, so deleting it may free less than shown · "
                      : `Automatic database snapshot · ${formatByteSize(logicalBytes)} logical, about ${formatByteSize(bytes)} ${sharingNote} · `
                    : candidates.filter((other) => !isDatabaseSnapshotName(Path.basename(other)))
                          .length === 1
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
      section: provider.section,
      title: provider.title,
      description: provider.description,
      bytes: targets.reduce((n, t) => n + t.bytes, 0),
      reclaimableBytes: targets.filter((t) => t.safeToDelete).reduce((n, t) => n + t.bytes, 0),
      measurement:
        warnings.length ||
        snapshotEstimateMissing ||
        targets.some((t) => t.blockingReasons?.some((r) => r.code === "inspection_unavailable"))
          ? targets.some((t) => t.bytes > 0)
            ? "partial"
            : "unavailable"
          : "complete",
      eligibleThreadCount: 0,
      defaultSelected: false,
      impact: provider.impact,
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
  return { categories, reviews, sharedSnapshotBytes };
}
