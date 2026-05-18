import * as FS from "node:fs/promises";
import * as Path from "node:path";

export interface StoragePathWarningInput {
  readonly path: string;
  readonly reason: string;
}

export function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function isPathWithinRoot(input: {
  readonly root: string;
  readonly target: string;
}): boolean {
  const root = Path.resolve(input.root);
  const target = Path.resolve(input.target);
  const relative = Path.relative(root, target);
  return relative.length === 0 || (!relative.startsWith("..") && !Path.isAbsolute(relative));
}

export async function safeLstat(targetPath: string): Promise<import("node:fs").Stats | null> {
  try {
    return await FS.lstat(targetPath);
  } catch (error) {
    if (isEnoent(error)) {
      return null;
    }
    throw error;
  }
}

export async function validateDeletablePath(input: {
  readonly path: string;
  readonly allowedRoot: string;
  readonly allowRoot?: boolean | undefined;
}): Promise<
  { ok: true; stat: import("node:fs").Stats } | { ok: false; warning: StoragePathWarningInput }
> {
  const targetPath = Path.resolve(input.path);
  const allowedRoot = Path.resolve(input.allowedRoot);

  if (!input.allowRoot && targetPath === allowedRoot) {
    return {
      ok: false,
      warning: {
        path: targetPath,
        reason: "Refused to delete the category root directly.",
      },
    };
  }

  if (!isPathWithinRoot({ root: allowedRoot, target: targetPath })) {
    return {
      ok: false,
      warning: {
        path: targetPath,
        reason: "Path is outside the allowed storage cleanup root.",
      },
    };
  }

  const firstStat = await safeLstat(targetPath);
  if (firstStat === null) {
    return {
      ok: false,
      warning: {
        path: targetPath,
        reason: "Path no longer exists.",
      },
    };
  }

  if (firstStat.isSymbolicLink()) {
    return {
      ok: false,
      warning: {
        path: targetPath,
        reason: "Refused to delete a symbolic link.",
      },
    };
  }

  let rootRealPath: string;
  let targetRealPath: string;
  try {
    [rootRealPath, targetRealPath] = await Promise.all([
      FS.realpath(allowedRoot),
      FS.realpath(targetPath),
    ]);
  } catch (error) {
    return {
      ok: false,
      warning: {
        path: targetPath,
        reason: `Failed to resolve real path: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }

  if (!isPathWithinRoot({ root: rootRealPath, target: targetRealPath })) {
    return {
      ok: false,
      warning: {
        path: targetPath,
        reason: "Resolved path is outside the allowed storage cleanup root.",
      },
    };
  }

  const secondStat = await safeLstat(targetPath);
  if (secondStat === null) {
    return {
      ok: false,
      warning: {
        path: targetPath,
        reason: "Path disappeared before deletion.",
      },
    };
  }
  if (secondStat.isSymbolicLink()) {
    return {
      ok: false,
      warning: {
        path: targetPath,
        reason: "Refused to delete a path that became a symbolic link.",
      },
    };
  }

  return { ok: true, stat: secondStat };
}

export async function removeFileIfSafe(input: {
  readonly path: string;
  readonly allowedRoot: string;
}): Promise<{ reclaimedBytes: number; warning?: StoragePathWarningInput }> {
  const validation = await validateDeletablePath({
    path: input.path,
    allowedRoot: input.allowedRoot,
  });
  if (!validation.ok) {
    return { reclaimedBytes: 0, warning: validation.warning };
  }
  if (!validation.stat.isFile()) {
    return {
      reclaimedBytes: 0,
      warning: {
        path: input.path,
        reason: "Refused to unlink a non-file path.",
      },
    };
  }
  const bytes = validation.stat.size;
  try {
    await FS.unlink(input.path);
    return { reclaimedBytes: bytes };
  } catch (error) {
    if (isEnoent(error)) {
      return { reclaimedBytes: 0 };
    }
    return {
      reclaimedBytes: 0,
      warning: {
        path: input.path,
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function removeTreeIfSafe(input: {
  readonly path: string;
  readonly allowedRoot: string;
  readonly allowRoot?: boolean | undefined;
  readonly recursive?: boolean;
}): Promise<{ reclaimedBytes: number; warning?: StoragePathWarningInput }> {
  const validation = await validateDeletablePath({
    path: input.path,
    allowedRoot: input.allowedRoot,
    ...(input.allowRoot !== undefined ? { allowRoot: input.allowRoot } : {}),
  });
  if (!validation.ok) {
    if (validation.warning.reason === "Path no longer exists.") {
      return { reclaimedBytes: 0 };
    }
    return { reclaimedBytes: 0, warning: validation.warning };
  }
  const bytes = validation.stat.size;
  try {
    if (validation.stat.isDirectory()) {
      await FS.rm(input.path, { recursive: input.recursive ?? true, force: false });
    } else if (validation.stat.isFile()) {
      await FS.unlink(input.path);
    } else {
      return {
        reclaimedBytes: 0,
        warning: {
          path: input.path,
          reason: "Refused to delete an unsupported filesystem entry.",
        },
      };
    }
    return { reclaimedBytes: bytes };
  } catch (error) {
    if (isEnoent(error)) {
      return { reclaimedBytes: 0 };
    }
    return {
      reclaimedBytes: 0,
      warning: {
        path: input.path,
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
