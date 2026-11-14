import { storageLstat } from "./diskUsage.ts";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import {
  allocatedBytes,
  fileIdentity,
  sameFileIdentity,
  type FileIdentity,
  type StorageStats,
} from "./diskUsage.ts";

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
  return (
    relative.length === 0 ||
    (relative !== ".." && !relative.startsWith(`..${Path.sep}`) && !Path.isAbsolute(relative))
  );
}

export async function safeLstat(targetPath: string): Promise<StorageStats | null> {
  try {
    return await storageLstat(targetPath);
  } catch (error) {
    if (isEnoent(error)) {
      return null;
    }
    throw error;
  }
}

export type RemovalOutcome =
  | {
      readonly kind: "removed";
      readonly bytes: number;
      readonly reclaimedBytes: number;
      readonly warning?: never;
    }
  | { readonly kind: "absent"; readonly reclaimedBytes: 0; readonly warning?: never }
  | {
      readonly kind: "refused";
      readonly reason: string;
      readonly reclaimedBytes: 0;
      readonly warning: StoragePathWarningInput;
    }
  | {
      readonly kind: "failed";
      readonly code: string;
      readonly reclaimedBytes: 0;
      readonly warning: StoragePathWarningInput;
    };

type PathInput = {
  readonly path: string;
  readonly allowedRoot: string;
  readonly allowRoot?: boolean | undefined;
  readonly expectedIdentity?: FileIdentity | null | undefined;
  /** Worktree contents are separately checked under lifecycle/repository locks. */
  readonly directoryIdentityOnly?: boolean;
  readonly isCancelled?: (() => boolean) | undefined;
};
const absent = { kind: "absent", reclaimedBytes: 0 } as const;
function refused(path: string, reason: string): RemovalOutcome {
  return { kind: "refused", reason, reclaimedBytes: 0, warning: { path, reason } };
}
function failed(path: string, error: unknown): RemovalOutcome {
  if (isEnoent(error)) return absent;
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "UNKNOWN";
  return {
    kind: "failed",
    code,
    reclaimedBytes: 0,
    warning: { path, reason: error instanceof Error ? error.message : String(error) },
  };
}
export async function validateDeletablePath(
  input: PathInput,
): Promise<{ readonly kind: "validated"; readonly stat: StorageStats } | RemovalOutcome> {
  const targetPath = Path.resolve(input.path);
  const allowedRoot = Path.resolve(input.allowedRoot);
  if (!input.allowRoot && targetPath === allowedRoot)
    return refused(targetPath, "Refused to delete the category root directly.");
  if (!isPathWithinRoot({ root: allowedRoot, target: targetPath }))
    return refused(targetPath, "Path is outside the allowed storage cleanup root.");
  try {
    const first = await safeLstat(targetPath);
    if (!first) return absent;
    if (input.expectedIdentity === null)
      return refused(targetPath, "Path appeared after review. Rescan before deletion.");
    if (first.isSymbolicLink()) return refused(targetPath, "Refused to delete a symbolic link.");
    const sameIdentity = (a: FileIdentity, b: FileIdentity) =>
      input.directoryIdentityOnly
        ? a.dev === b.dev && a.ino === b.ino && (a.mode & 0o170000) === (b.mode & 0o170000)
        : sameFileIdentity(a, b);
    if (input.expectedIdentity && !sameIdentity(input.expectedIdentity, fileIdentity(first)))
      return refused(targetPath, "Path identity changed since review.");
    const [rootRealPath, targetRealPath] = await Promise.all([
      FS.realpath(allowedRoot),
      FS.realpath(targetPath),
    ]);
    if (!isPathWithinRoot({ root: rootRealPath, target: targetRealPath }))
      return refused(targetPath, "Resolved path is outside the allowed storage cleanup root.");
    const second = await safeLstat(targetPath);
    if (!second) return absent;
    if (second.isSymbolicLink() || !sameIdentity(fileIdentity(first), fileIdentity(second)))
      return refused(targetPath, "Path identity changed before deletion.");
    return { kind: "validated", stat: second };
  } catch (error) {
    return failed(targetPath, error);
  }
}
export async function removeFileIfSafe(input: PathInput): Promise<RemovalOutcome> {
  if (input.isCancelled?.()) return refused(input.path, "Cleanup was cancelled.");
  const validation = await validateDeletablePath(input);
  if (validation.kind !== "validated") return validation;
  if (!validation.stat.isFile()) return refused(input.path, "Refused to unlink a non-file path.");
  if (input.isCancelled?.()) return refused(input.path, "Cleanup was cancelled.");
  try {
    await FS.unlink(input.path);
    const bytes = allocatedBytes(validation.stat);
    return { kind: "removed", bytes, reclaimedBytes: bytes };
  } catch (error) {
    return failed(input.path, error);
  }
}
export async function removeTreeIfSafe(
  input: PathInput & { readonly recursive?: boolean },
): Promise<RemovalOutcome> {
  if (input.isCancelled?.()) return refused(input.path, "Cleanup was cancelled.");
  const validation = await validateDeletablePath(input);
  if (validation.kind !== "validated") return validation;
  if (input.isCancelled?.()) return refused(input.path, "Cleanup was cancelled.");
  try {
    if (validation.stat.isDirectory())
      await FS.rm(input.path, { recursive: input.recursive ?? true, force: false });
    else if (validation.stat.isFile()) await FS.unlink(input.path);
    else return refused(input.path, "Refused to delete an unsupported filesystem entry.");
    const bytes = allocatedBytes(validation.stat);
    return { kind: "removed", bytes, reclaimedBytes: bytes };
  } catch (error) {
    return failed(input.path, error);
  }
}
