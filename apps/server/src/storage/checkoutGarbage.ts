import { randomUUID } from "node:crypto";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import type { Dirent } from "node:fs";
import type { StoragePathWarning } from "@t3tools/contracts";
import {
  allocatedBytes,
  fileIdentity,
  enumerateFiles,
  measureTree,
  recursiveSize,
  storageLstat,
  storageReadDir,
  type FileIdentity,
} from "./diskUsage.ts";
import {
  activityForTarget,
  inspectWindowsFileUse,
  readStorageProcesses,
  type StorageActivity,
  type StorageProcess,
} from "./storageActivity.ts";
import { removeTreeIfSafe, safeLstat, validateDeletablePath } from "./storagePathSafety.ts";

/**
 * Regenerable folders inside checkouts (`node_modules`, `.venv`, `.turbo`)
 * and Git's leftover temporary packs. Both are found per checkout, never by
 * walking arbitrary folders.
 */

/** A dependency folder this deep below its checkout is still found (`a/b/c/node_modules`). */
export const DEPENDENCY_SCAN_MAX_DEPTH = 4;
export const DEPENDENCY_QUARANTINE_PREFIX = ".f5-deps-trash-";
/** Git deletes these when a fetch finishes; older ones were left by an interrupted fetch. */
export const TEMPORARY_PACK_MIN_AGE_MS = 24 * 60 * 60 * 1_000;
const SKIP = new Set([
  ".git",
  "vendor",
  "target",
  "build",
  "dist",
  ".cache",
  ".terraform",
  "dist-electron",
  "dist-native",
  ".electron-runtime",
]);

export type DependencyFolderKind = "node_modules" | ".venv" | ".turbo" | "quarantine";

export interface CheckoutInput {
  /** Canonical checkout root. */
  readonly root: string;
  /** The repository's Git common dir, when known; temporary packs are read from it. */
  readonly commonDir: string | null;
}

export interface DependencyFolderCandidate {
  readonly path: string;
  readonly checkoutRoot: string;
  readonly kind: DependencyFolderKind;
  readonly identity: FileIdentity;
  readonly bytes: number;
  /** How to get the folder back, for the target detail. */
  readonly restoreHint: string;
}

export interface TemporaryPackCandidate {
  readonly path: string;
  readonly packDirectory: string;
  readonly repositoryRoot: string;
  readonly identity: FileIdentity;
  readonly bytes: number;
}

export interface CheckoutGarbageScan {
  readonly folders: ReadonlyArray<DependencyFolderCandidate>;
  readonly packs: ReadonlyArray<TemporaryPackCandidate>;
  /** False when sizing ran out of time; folder sizes are then partial. */
  readonly measured: boolean;
  readonly warnings: ReadonlyArray<StoragePathWarning>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function exists(path: string): Promise<boolean> {
  return (await safeLstat(path).catch(() => null)) !== null;
}

async function classify(directory: string, name: string): Promise<DependencyFolderKind | null> {
  if (name === "node_modules") return "node_modules";
  if (name === ".turbo") return ".turbo";
  if (name.startsWith(DEPENDENCY_QUARANTINE_PREFIX)) return "quarantine";
  if (name === ".venv")
    return (await exists(Path.join(directory, name, "pyvenv.cfg"))) ? ".venv" : null;
  return null;
}

async function restoreHint(path: string, kind: DependencyFolderKind): Promise<string> {
  const parent = Path.dirname(path);
  const first = async (entries: ReadonlyArray<readonly [string, string]>, fallback: string) => {
    for (const [file, hint] of entries) if (await exists(Path.join(parent, file))) return hint;
    return fallback;
  };
  switch (kind) {
    case "node_modules":
      return first(
        [
          ["bun.lock", "restore with bun install"],
          ["bun.lockb", "restore with bun install"],
          ["pnpm-lock.yaml", "restore with pnpm install"],
          ["yarn.lock", "restore with yarn install"],
          ["package-lock.json", "restore with npm install"],
        ],
        "restore by reinstalling dependencies",
      );
    case ".venv":
      return first(
        [
          ["uv.lock", "restore with uv sync"],
          ["poetry.lock", "restore with poetry install"],
        ],
        "recreate the virtual environment to restore",
      );
    case ".turbo":
      return "rebuilt on the next build";
    case "quarantine":
      return "left by an interrupted F5 cleanup";
  }
}

/**
 * Dependency folders of one checkout, at most {@link DEPENDENCY_SCAN_MAX_DEPTH}
 * levels down. Does not follow symlinks, descend into a match, or enter a
 * nested checkout (a folder with its own `.git`), which is scanned on its own.
 */
export async function findDependencyFolders(
  checkoutRoot: string,
  signal?: AbortSignal,
  /** Folders an earlier scan already found free of Git checkouts, unchanged since. */
  isKnownClean: (path: string, identity: FileIdentity) => boolean = () => false,
): Promise<{
  readonly folders: ReadonlyArray<{
    readonly path: string;
    readonly kind: DependencyFolderKind;
    readonly identity: FileIdentity;
  }>;
  readonly warnings: ReadonlyArray<StoragePathWarning>;
}> {
  const folders: Array<{ path: string; kind: DependencyFolderKind; identity: FileIdentity }> = [];
  const warnings: StoragePathWarning[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    let entries: Dirent[];
    try {
      entries = await storageReadDir(directory, { withFileTypes: true }, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        warnings.push({ path: directory, reason: message(error) });
      return;
    }
    for (const entry of entries) {
      // Dirent reports symlinks as links, never as directories.
      if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
      const path = Path.join(directory, entry.name);
      const kind = await classify(directory, entry.name);
      if (kind) {
        const stat = await safeLstat(path).catch(() => null);
        if (stat?.isDirectory() && !stat.isSymbolicLink()) {
          // A package may itself be a checkout. Keep its Git history and
          // unpushed work out of dependency cleanup, including nested repos.
          // Deletion checks again whatever the scan reused.
          const identity = fileIdentity(stat);
          if (!isKnownClean(path, identity) && (await containsGitEntry(path, signal))) continue;
          folders.push({ path, kind, identity });
        }
        continue;
      }
      if (depth + 1 >= DEPENDENCY_SCAN_MAX_DEPTH) continue;
      if (await exists(Path.join(path, ".git"))) continue;
      await visit(path, depth + 1);
    }
  };
  const root = await safeLstat(checkoutRoot).catch(() => null);
  if (root?.isDirectory() && !root.isSymbolicLink()) await visit(checkoutRoot, 0);
  return { folders, warnings };
}

async function containsGitEntry(root: string, signal?: AbortSignal): Promise<boolean> {
  const visit = async (directory: string): Promise<boolean> => {
    signal?.throwIfAborted();
    let entries: Dirent[];
    try {
      entries = await storageReadDir(directory, { withFileTypes: true }, signal);
    } catch {
      signal?.throwIfAborted();
      // Fail closed if part of the candidate cannot be checked.
      return true;
    }
    for (const entry of entries) {
      if (entry.name === ".git") return true;
      if (!entry.isDirectory()) continue;
      if (await visit(Path.join(directory, entry.name))) return true;
    }
    return false;
  };
  return visit(root);
}

/** Temporary pack files Git left in one repository, older than a day. */
export async function findTemporaryPacks(
  commonDir: string,
  nowMs: number,
): Promise<ReadonlyArray<TemporaryPackCandidate>> {
  const packDirectory = Path.join(commonDir, "objects", "pack");
  const entries = await storageReadDir(packDirectory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return [] as Dirent[];
      throw error;
    },
  );
  const repositoryRoot = Path.basename(commonDir) === ".git" ? Path.dirname(commonDir) : commonDir;
  const packs: TemporaryPackCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^tmp_(?:pack|idx)_/.test(entry.name)) continue;
    const path = Path.join(packDirectory, entry.name);
    const stat = await safeLstat(path).catch(() => null);
    if (!stat?.isFile() || stat.mtimeMs > nowMs - TEMPORARY_PACK_MIN_AGE_MS) continue;
    packs.push({
      path,
      packDirectory,
      repositoryRoot,
      identity: fileIdentity(stat),
      bytes: allocatedBytes(stat),
    });
  }
  return packs;
}

/** A folder an earlier scan sized completely and found free of Git checkouts. */
export interface KnownDependencyFolder {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly bytes: number;
}

const sameFolder = (left: FileIdentity, right: FileIdentity) =>
  left.dev === right.dev && left.ino === right.ino && left.mtimeMs === right.mtimeMs;

export async function scanCheckoutGarbage(input: {
  readonly checkouts: ReadonlyArray<CheckoutInput>;
  readonly nowMs: number;
  /** Search budget across every checkout; folders past it are not listed. */
  readonly discoveryBudgetMs: number;
  /** Sizing budget across every folder; sizes are partial past it. */
  readonly sizeBudgetMs: number;
  /**
   * Reused without walking them again while their root is unchanged. A
   * package added or removed changes the root's mtime; changes deeper inside
   * leave the estimate stale until the folder itself changes.
   */
  readonly known?: ReadonlyArray<KnownDependencyFolder>;
  readonly signal?: AbortSignal;
}): Promise<CheckoutGarbageScan> {
  const warnings: StoragePathWarning[] = [];
  const known = new Map((input.known ?? []).map((folder) => [folder.path, folder]));
  const reusable = (path: string, identity: FileIdentity) => {
    const previous = known.get(path);
    return previous !== undefined && sameFolder(previous.identity, identity);
  };
  const found: Array<{
    path: string;
    checkoutRoot: string;
    kind: DependencyFolderKind;
    identity: FileIdentity;
  }> = [];
  const seenFolders = new Set<string>();
  const discoveryBudget =
    input.discoveryBudgetMs > 0
      ? AbortSignal.timeout(input.discoveryBudgetMs)
      : AbortSignal.abort();
  const discoverySignal = input.signal
    ? AbortSignal.any([input.signal, discoveryBudget])
    : discoveryBudget;
  for (const checkout of input.checkouts) {
    let result: Awaited<ReturnType<typeof findDependencyFolders>>;
    try {
      result = await findDependencyFolders(checkout.root, discoverySignal, reusable);
    } catch (error) {
      input.signal?.throwIfAborted();
      if (!discoveryBudget.aborted) throw error;
      // Keep what was found; a folder whose Git check was cut short is not listed.
      warnings.push({
        path: checkout.root,
        reason: "Dependency folder search ran out of time; some folders are not listed.",
      });
      break;
    }
    warnings.push(...result.warnings);
    for (const folder of result.folders) {
      if (seenFolders.has(folder.path)) continue;
      seenFolders.add(folder.path);
      found.push({ ...folder, checkoutRoot: checkout.root });
    }
  }
  const packs: TemporaryPackCandidate[] = [];
  for (const commonDir of new Set(
    input.checkouts.flatMap((checkout) => (checkout.commonDir ? [checkout.commonDir] : [])),
  )) {
    input.signal?.throwIfAborted();
    try {
      packs.push(...(await findTemporaryPacks(commonDir, input.nowMs)));
    } catch (error) {
      warnings.push({ path: commonDir, reason: message(error) });
    }
  }
  const budget = AbortSignal.timeout(input.sizeBudgetMs);
  const signal = input.signal ? AbortSignal.any([input.signal, budget]) : budget;
  const paths = found
    .filter((folder) => !reusable(folder.path, folder.identity))
    .map((folder) => folder.path);
  const sized = paths.length
    ? await measureTree(paths, { checkpoints: paths, allowPartial: true, maxDepth: 64, signal })
    : null;
  input.signal?.throwIfAborted();
  const measured = !budget.aborted;
  if (!measured)
    warnings.push({
      path: input.checkouts[0]?.root ?? "",
      reason: "Dependency folder sizing ran out of time; sizes are partial.",
    });
  const folders: DependencyFolderCandidate[] = [];
  for (const folder of found)
    folders.push({
      ...folder,
      bytes: reusable(folder.path, folder.identity)
        ? known.get(folder.path)!.bytes
        : (sized?.byCheckpoint.get(Path.resolve(folder.path))?.bytes ?? 0),
      restoreHint: await restoreHint(folder.path, folder.kind),
    });
  return { folders, packs, measured, warnings };
}

/**
 * Detaches a reviewed dependency folder to a sibling quarantine, then deletes
 * the quarantine. A checkout never keeps a half-deleted `node_modules`; an
 * interrupted deletion leaves a quarantine folder the next scan offers again.
 */
export async function removeDependencyFolder(
  input: {
    readonly path: string;
    readonly checkoutRoot: string;
    readonly identity: FileIdentity;
  },
  readProcesses: () => Promise<StorageProcess[]> = () => readStorageProcesses(),
): Promise<{
  readonly activity: StorageActivity;
  /**
   * `absent`: already gone. `refused`: left untouched, see `reason`. A thrown
   * error means deletion may have started; a quarantine is offered again.
   */
  readonly outcome: "removed" | "absent" | "busy" | "refused";
  readonly reason?: string;
  readonly removedBytes: number;
  readonly warnings: ReadonlyArray<StoragePathWarning>;
}> {
  const untouched = (
    outcome: "absent" | "busy" | "refused",
    activity: StorageActivity,
    reason?: string,
  ) => ({ activity, outcome, ...(reason ? { reason } : {}), removedBytes: 0, warnings: [] });
  // Anything running inside the checkout may be using its dependencies.
  const activity = activityForTarget(await FS.realpath(input.checkoutRoot), await readProcesses());
  if (activity.state !== "idle") return untouched("busy", activity);
  const validation = await validateDeletablePath({
    path: input.path,
    allowedRoot: input.checkoutRoot,
    expectedIdentity: input.identity,
    directoryIdentityOnly: true,
  });
  if (validation.kind === "absent") return untouched("absent", activity);
  if (validation.kind !== "validated")
    return untouched(
      "refused",
      activity,
      validation.kind === "refused" ? validation.reason : "Cleanup target changed.",
    );
  if (!validation.stat.isDirectory())
    return untouched("refused", activity, "Refused to delete a non-directory.");
  // An install since review changes the folder's mtime; leave it for a rescan.
  if (validation.stat.mtimeMs !== input.identity.mtimeMs)
    return untouched("refused", activity, "Folder changed since review. Rescan before deletion.");
  // Reject protected repositories before probing their files. Windows probes
  // may be unavailable or slow; neither should obscure this definitive refusal.
  const refuseGitCheckout = () =>
    untouched(
      "refused",
      activity,
      "Folder contains a Git checkout. Rescan after moving or removing it.",
    );
  if (await containsGitEntry(input.path)) return refuseGitCheckout();
  if (process.platform === "win32") {
    const files = await enumerateFiles(input.path, { maxDepth: 64 });
    if (files.errors.length)
      return untouched("refused", activity, "Could not inspect dependency files for active use.");
    const fileUse = await inspectWindowsFileUse(files.files.map((file) => file.path));
    if (fileUse.state !== "idle") return untouched("busy", fileUse);
    // A checkout can appear while the native file-use probe is running.
    if (await containsGitEntry(input.path)) return refuseGitCheckout();
  }
  let quarantine = input.path;
  if (!Path.basename(input.path).startsWith(DEPENDENCY_QUARANTINE_PREFIX)) {
    quarantine = Path.join(Path.dirname(input.path), DEPENDENCY_QUARANTINE_PREFIX + randomUUID());
    await FS.rename(input.path, quarantine);
    const moved = await storageLstat(quarantine);
    if (moved.dev !== input.identity.dev || moved.exactIno !== input.identity.ino)
      throw new Error("Folder identity changed before quarantine. Files retained.");
  }
  const size = await recursiveSize(quarantine, { maxDepth: 64 });
  const removal = await removeTreeIfSafe({
    path: quarantine,
    allowedRoot: input.checkoutRoot,
    expectedIdentity: input.identity,
    directoryIdentityOnly: true,
    recursive: true,
  });
  if (removal.kind === "removed")
    return { activity, outcome: "removed", removedBytes: size.bytes, warnings: [] };
  return {
    activity,
    outcome: "refused",
    reason: "The folder was moved aside but not deleted; it is offered again after a rescan.",
    removedBytes: 0,
    warnings: removal.warning ? [removal.warning] : [],
  };
}
