import * as fs from "node:fs";
import * as path from "node:path";

interface DownloadItemLike {
  getFilename(): string;
  getStartTime(): number;
  getTotalBytes(): number;
  getReceivedBytes(): number;
  setSavePath(path: string): void;
  cancel(): void;
  on(event: "updated" | "done", listener: () => void): unknown;
}

/** A page the agent visits cannot fill the disk: each download is capped, and so is the folder. */
export const AGENT_DOWNLOAD_MAX_BYTES = 256 * 1024 * 1024;
export const AGENT_DOWNLOADS_KEPT = 50;
/** Saved downloads are capped in total too, so the kept ones cannot fill the disk either. */
export const AGENT_DOWNLOADS_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
/** Downloads still being written to one folder; each may reach `AGENT_DOWNLOAD_MAX_BYTES`. */
export const AGENT_DOWNLOADS_IN_FLIGHT = 4;

/**
 * Removes the oldest saved downloads until at most `keep` remain within `maxTotalBytes`, best
 * effort. Downloads still being written, named in `inFlight`, are left alone.
 */
export function pruneAgentDownloads(
  directory: string,
  options: {
    readonly keep?: number;
    readonly maxTotalBytes?: number;
    readonly inFlight?: ReadonlySet<string>;
  } = {},
): void {
  const keep = options.keep ?? AGENT_DOWNLOADS_KEPT;
  const maxTotalBytes = options.maxTotalBytes ?? AGENT_DOWNLOADS_MAX_TOTAL_BYTES;
  const inFlight = [...(options.inFlight ?? [])];
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => name.startsWith("browser-download-"));
  } catch {
    return;
  }
  const files = names.flatMap((name) => {
    const file = path.join(directory, name);
    // Chromium may write next to the save path under a temporary suffix.
    if (inFlight.some((savePath) => file.startsWith(savePath))) return [];
    try {
      const stat = fs.statSync(file);
      return [{ file, mtime: stat.mtimeMs, size: stat.size }];
    } catch {
      return [];
    }
  });
  files.sort((left, right) => right.mtime - left.mtime);
  let kept = 0;
  let keptBytes = 0;
  for (const entry of files) {
    if (kept < keep && keptBytes + entry.size <= maxTotalBytes) {
      kept += 1;
      keptBytes += entry.size;
      continue;
    }
    try {
      fs.rmSync(entry.file, { force: true });
    } catch {
      // The next prune tries again.
    }
  }
}

interface DownloadSessionLike {
  on(
    event: "will-download",
    listener: (event: unknown, item: DownloadItemLike, source: { readonly id: number }) => void,
  ): unknown;
}

const installedSessions = new WeakSet<object>();
let downloadCount = 0;

/**
 * Electron opens a native Save dialog for a download with no save path, so every export an agent
 * clicked while testing a page put a modal over the whole app. A download from a page the agent
 * is driving is saved to the directory of the profile that owns the page instead; one the
 * user starts, or one whose owning profile is unknown, keeps the Save dialog.
 * Installed once per session.
 */
export function installAgentDownloadHandler(
  session: DownloadSessionLike,
  options: {
    /** The owning profile's download folder for a source page, or undefined when unknown. */
    readonly directoryFor: (sourceWebContentsId: number) => string | undefined;
    readonly isAgentDriven: (sourceWebContentsId: number) => boolean;
    readonly ensureDirectory?: (directory: string) => void;
    /** Runs before each saved download and after each one ends, so the folder stays bounded. */
    readonly prune?: (directory: string, inFlight: ReadonlySet<string>) => void;
  },
): void {
  if (installedSessions.has(session)) return;
  installedSessions.add(session);
  const ensureDirectory =
    options.ensureDirectory ?? ((target: string) => fs.mkdirSync(target, { recursive: true }));
  const prune =
    options.prune ??
    ((directory: string, inFlight: ReadonlySet<string>) =>
      pruneAgentDownloads(directory, { inFlight }));
  const inFlightByDirectory = new Map<string, Set<string>>();
  session.on("will-download", (_event, item, source) => {
    if (!options.isAgentDriven(source.id)) return;
    const directory = options.directoryFor(source.id);
    if (directory === undefined) return;
    // Without a save path Electron would show its Save dialog, so a refused download is
    // cancelled instead of falling back to one.
    if (item.getTotalBytes() > AGENT_DOWNLOAD_MAX_BYTES) {
      item.cancel();
      return;
    }
    const inFlight = inFlightByDirectory.get(directory) ?? new Set<string>();
    if (inFlight.size >= AGENT_DOWNLOADS_IN_FLIGHT) {
      item.cancel();
      return;
    }
    // This runs in Electron's main-process listener: a full disk or a permission error cancels
    // the download rather than escaping before the item is handled.
    try {
      ensureDirectory(directory);
      prune(directory, inFlight);
    } catch (error) {
      console.warn(
        `Cancelled an agent download: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`,
      );
      item.cancel();
      return;
    }
    // The start time keeps names unique across restarts; the count keeps two same-name
    // downloads in one millisecond from overwriting each other.
    const id = `${Math.round(item.getStartTime() * 1000).toString(36)}-${(downloadCount++).toString(36)}`;
    const savePath = path.join(
      directory,
      `browser-download-${id}-${path.basename(item.getFilename())}`,
    );
    inFlight.add(savePath);
    inFlightByDirectory.set(directory, inFlight);
    // A server may not send the size, so the received bytes are checked as they arrive.
    item.on("updated", () => {
      if (item.getReceivedBytes() > AGENT_DOWNLOAD_MAX_BYTES) item.cancel();
    });
    item.on("done", () => {
      inFlight.delete(savePath);
      if (inFlight.size === 0) inFlightByDirectory.delete(directory);
      try {
        prune(directory, inFlight);
      } catch {
        // The next download prunes again.
      }
    });
    item.setSavePath(savePath);
  });
}
