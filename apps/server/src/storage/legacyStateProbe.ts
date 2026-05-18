import * as OS from "node:os";
import * as FS from "node:fs/promises";
import * as Path from "node:path";

import type { StorageCleanupTarget, StoragePathWarning } from "@t3tools/contracts";
import {
  defaultF5BaseDir,
  legacyT3BaseDir,
  STATE_DB_FILE_NAME,
  USERDATA_STATE_DIR_NAME,
} from "@t3tools/shared/appStatePaths";

import type { ServerConfigShape } from "../config.ts";
import { LEGACY_STATE_MIGRATION_FAILURE_SENTINEL } from "../legacyStateMigration.ts";
import { recursiveSize } from "./diskUsage.ts";

const LEGACY_WORKTREE_SCAN_MAX_DEPTH = 4;

export interface LegacyProbeResult {
  readonly envOverrideActive: boolean;
  readonly disabledReason?: string;
  readonly bytes: number;
  readonly warnings: ReadonlyArray<StoragePathWarning>;
  readonly targetsByCategory: Readonly<
    Partial<
      Record<
        | "legacyT3Userdata"
        | "legacyT3Diverged"
        | "legacyT3Worktrees"
        | "legacyT3Dev"
        | "legacyT3Caches"
        | "legacyT3Root"
        | "f5UserdataEmpty",
        ReadonlyArray<StorageCleanupTarget>
      >
    >
  >;
}

type LegacyProbeCategoryId = keyof NonNullable<LegacyProbeResult["targetsByCategory"]>;

async function pathExists(path: string): Promise<boolean> {
  try {
    await FS.lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function directoryRootState(
  path: string,
  warnings: StoragePathWarning[],
): Promise<"missing" | "ready" | "refused"> {
  let stat: import("node:fs").Stats;
  try {
    stat = await FS.lstat(path);
  } catch {
    return "missing";
  }
  if (stat.isSymbolicLink()) {
    warnings.push({
      path,
      reason: "Refused to scan a symbolic-link legacy storage root.",
    });
    return "refused";
  }
  if (!stat.isDirectory()) {
    warnings.push({
      path,
      reason: "Refused to scan a non-directory legacy storage root.",
    });
    return "refused";
  }
  return "ready";
}

async function fileExistsNonEmpty(path: string): Promise<boolean> {
  try {
    const stat = await FS.lstat(path);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function sizeTarget(input: {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly safeToDelete: boolean;
  readonly disabledReason?: string | undefined;
  readonly detail?: string | undefined;
  readonly warnings: StoragePathWarning[];
}): Promise<StorageCleanupTarget | null> {
  let stat: import("node:fs").Stats;
  try {
    stat = await FS.lstat(input.path);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink()) {
    input.warnings.push({
      path: input.path,
      reason: "Refused to size a symbolic-link legacy storage target.",
    });
    return {
      id: input.id,
      label: input.label,
      path: input.path,
      bytes: stat.size,
      safeToDelete: false,
      disabledReason: "Symbolic links are not eligible for cleanup.",
      ...(input.detail ? { detail: input.detail } : {}),
    };
  }
  const usage = await recursiveSize(input.path);
  input.warnings.push(...usage.errors);
  return {
    id: input.id,
    label: input.label,
    path: input.path,
    bytes: usage.bytes,
    safeToDelete: input.safeToDelete,
    ...(input.disabledReason ? { disabledReason: input.disabledReason } : {}),
    ...(input.detail ? { detail: input.detail } : {}),
  };
}

function normalizePathForCompare(path: string): string {
  return Path.resolve(path);
}

function pathsOverlap(leftPath: string, rightPath: string): boolean {
  const left = normalizePathForCompare(leftPath);
  const right = normalizePathForCompare(rightPath);
  const leftToRight = Path.relative(left, right);
  const rightToLeft = Path.relative(right, left);
  return (
    leftToRight.length === 0 ||
    (!leftToRight.startsWith("..") && !Path.isAbsolute(leftToRight)) ||
    rightToLeft.length === 0 ||
    (!rightToLeft.startsWith("..") && !Path.isAbsolute(rightToLeft))
  );
}

function anyEnvOverrideActive(): boolean {
  return ["F5_HOME", "T3CODE_HOME", "F5_STATE_DIR", "T3CODE_STATE_DIR"].some((name) => {
    const value = process.env[name];
    return value !== undefined && value.trim().length > 0;
  });
}

function sumTargetBytes(targets: ReadonlyArray<StorageCleanupTarget> | undefined): number {
  return (targets ?? []).reduce((total, target) => total + target.bytes, 0);
}

async function listLegacyGitWorktreeDirectories(input: {
  readonly root: string;
  readonly maxDepth: number;
  readonly warnings: StoragePathWarning[];
}): Promise<ReadonlyArray<string>> {
  const paths: string[] = [];

  const visit = async (directory: string, depth: number): Promise<void> => {
    const gitPath = Path.join(directory, ".git");
    let gitStat: import("node:fs").Stats | null = null;
    try {
      gitStat = await FS.lstat(gitPath);
    } catch {
      gitStat = null;
    }
    if (gitStat?.isFile() === true) {
      paths.push(directory);
      return;
    }
    if (depth >= input.maxDepth) {
      return;
    }

    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await FS.readdir(directory, { withFileTypes: true });
    } catch (error) {
      input.warnings.push({
        path: directory,
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    for (const entry of entries) {
      const entryPath = Path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        input.warnings.push({
          path: entryPath,
          reason: "Skipped symbolic link.",
        });
        continue;
      }
      if (!entry.isDirectory()) {
        continue;
      }
      await visit(entryPath, depth + 1);
    }
  };

  await visit(input.root, 0);
  return paths.toSorted((left, right) => left.localeCompare(right));
}

export async function probeLegacyState(input: {
  readonly config: ServerConfigShape;
  readonly liveWorktreePaths: ReadonlySet<string>;
  readonly homeDir?: string;
}): Promise<LegacyProbeResult> {
  const homeDir = input.homeDir ?? OS.homedir();
  const legacyBase = legacyT3BaseDir(homeDir);
  const f5Base = defaultF5BaseDir(homeDir);
  const legacyUserdata = Path.join(legacyBase, USERDATA_STATE_DIR_NAME);
  const legacyWorktrees = Path.join(legacyBase, "worktrees");
  const legacyDev = Path.join(legacyBase, "dev");
  const legacyCaches = Path.join(legacyBase, "caches");
  const f5UserdataDb = Path.join(f5Base, USERDATA_STATE_DIR_NAME, STATE_DB_FILE_NAME);
  const migrationFailureSentinel = Path.join(
    f5Base,
    USERDATA_STATE_DIR_NAME,
    LEGACY_STATE_MIGRATION_FAILURE_SENTINEL,
  );
  const warnings: StoragePathWarning[] = [];
  const legacyBaseState = await directoryRootState(legacyBase, warnings);
  const f5BaseState = await directoryRootState(f5Base, warnings);

  const envOverrideActive = anyEnvOverrideActive();
  let disabledReason: string | undefined;
  const f5DbReady = await fileExistsNonEmpty(f5UserdataDb);
  const failureSentinelExists = await pathExists(migrationFailureSentinel);
  if (envOverrideActive) {
    disabledReason =
      "Disabled because custom F5_HOME, F5_STATE_DIR, T3CODE_HOME, or T3CODE_STATE_DIR is in effect.";
  } else if (!f5DbReady) {
    disabledReason = "Disabled until the default F5 userdata database exists and is non-empty.";
  } else if (legacyBaseState === "refused" || f5BaseState === "refused") {
    disabledReason =
      "Disabled because a default legacy/F5 storage root is a symbolic link or file.";
  } else if (failureSentinelExists) {
    disabledReason = "Disabled because the legacy T3 migration failure sentinel exists.";
  } else if (input.config.devUrl !== undefined) {
    disabledReason = "Disabled while running against a development web server.";
  }

  const gateSafe = disabledReason === undefined;
  const targetsByCategory: Partial<Record<LegacyProbeCategoryId, StorageCleanupTarget[]>> = {};

  const addTarget = async (
    category: LegacyProbeCategoryId,
    target: Promise<StorageCleanupTarget | null>,
  ) => {
    const resolved = await target;
    if (!resolved) {
      return;
    }
    targetsByCategory[category] = [...(targetsByCategory[category] ?? []), resolved];
  };

  await addTarget(
    "legacyT3Userdata",
    legacyBaseState === "ready"
      ? sizeTarget({
          id: "legacy-t3-userdata",
          label: "~/.t3/userdata",
          path: legacyUserdata,
          safeToDelete: gateSafe,
          disabledReason,
          detail: "Migrated source state.",
          warnings,
        })
      : Promise.resolve(null),
  );

  if (legacyBaseState === "ready") {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await FS.readdir(legacyBase, { withFileTypes: true });
    } catch (error) {
      warnings.push({
        path: legacyBase,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    for (const entry of entries) {
      const entryPath = Path.join(legacyBase, entry.name);
      if (entry.isDirectory() && /^userdata\.f5-diverged\.\d{8}-\d{6}$/.test(entry.name)) {
        await addTarget(
          "legacyT3Diverged",
          sizeTarget({
            id: entry.name,
            label: entry.name,
            path: entryPath,
            safeToDelete: gateSafe,
            disabledReason,
            detail: "Manual migration snapshot.",
            warnings,
          }),
        );
      }
    }
  }

  await addTarget(
    "legacyT3Dev",
    legacyBaseState === "ready"
      ? sizeTarget({
          id: "legacy-t3-dev",
          label: "~/.t3/dev",
          path: legacyDev,
          safeToDelete: gateSafe && input.config.devUrl === undefined,
          disabledReason:
            disabledReason ??
            (input.config.devUrl !== undefined ? "Development URL is active." : undefined),
          detail: "Legacy development state.",
          warnings,
        })
      : Promise.resolve(null),
  );

  await addTarget(
    "legacyT3Caches",
    legacyBaseState === "ready"
      ? sizeTarget({
          id: "legacy-t3-caches",
          label: "~/.t3/caches",
          path: legacyCaches,
          safeToDelete: gateSafe,
          disabledReason,
          detail: "Rebuilt on demand.",
          warnings,
        })
      : Promise.resolve(null),
  );

  if (
    legacyBaseState === "ready" &&
    (await directoryRootState(legacyWorktrees, warnings)) === "ready"
  ) {
    const worktreePaths = await listLegacyGitWorktreeDirectories({
      root: legacyWorktrees,
      maxDepth: LEGACY_WORKTREE_SCAN_MAX_DEPTH,
      warnings,
    });
    for (const worktreePath of worktreePaths) {
      const referenced = Array.from(input.liveWorktreePaths).some((liveWorktreePath) =>
        pathsOverlap(worktreePath, liveWorktreePath),
      );
      const relativePath = Path.relative(legacyWorktrees, worktreePath);
      await addTarget(
        "legacyT3Worktrees",
        sizeTarget({
          id: relativePath,
          label: relativePath,
          path: worktreePath,
          safeToDelete: gateSafe && !referenced,
          disabledReason:
            disabledReason ?? (referenced ? "Referenced by a live thread." : undefined),
          detail: referenced ? "Live thread worktree." : "Legacy Git worktree.",
          warnings,
        }),
      );
    }
  }

  if (f5BaseState === "ready") {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await FS.readdir(f5Base, { withFileTypes: true });
    } catch (error) {
      warnings.push({
        path: f5Base,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    for (const entry of entries) {
      if (entry.isDirectory() && /^userdata\.empty\.\d{8}-\d{6}$/.test(entry.name)) {
        const targetPath = Path.join(f5Base, entry.name);
        await addTarget(
          "f5UserdataEmpty",
          sizeTarget({
            id: entry.name,
            label: entry.name,
            path: targetPath,
            safeToDelete: gateSafe,
            disabledReason,
            detail: "Empty userdata artifact.",
            warnings,
          }),
        );
      }
    }
  }

  if (legacyBaseState === "ready") {
    let entries: string[] = [];
    try {
      entries = (await FS.readdir(legacyBase)).filter((entry) => entry !== ".DS_Store");
    } catch (error) {
      warnings.push({
        path: legacyBase,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    const rootIsEmpty = entries.length === 0;
    await addTarget(
      "legacyT3Root",
      sizeTarget({
        id: "legacy-t3-root",
        label: "~/.t3",
        path: legacyBase,
        safeToDelete: gateSafe && rootIsEmpty,
        disabledReason:
          disabledReason ?? (rootIsEmpty ? undefined : "Delete legacy subdirectories first."),
        detail: rootIsEmpty ? "Empty legacy root." : "Legacy root is not empty.",
        warnings,
      }),
    );
  }

  const legacyRootBytes =
    targetsByCategory.legacyT3Root?.[0]?.bytes ??
    sumTargetBytes(targetsByCategory.legacyT3Userdata) +
      sumTargetBytes(targetsByCategory.legacyT3Diverged) +
      sumTargetBytes(targetsByCategory.legacyT3Worktrees) +
      sumTargetBytes(targetsByCategory.legacyT3Dev) +
      sumTargetBytes(targetsByCategory.legacyT3Caches);
  const bytes = legacyRootBytes + sumTargetBytes(targetsByCategory.f5UserdataEmpty);

  return {
    envOverrideActive,
    ...(disabledReason ? { disabledReason } : {}),
    bytes,
    warnings,
    targetsByCategory,
  };
}
