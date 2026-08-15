import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

export const WORKSPACE_IMAGE_ASSET_MAX_BYTES = 10 * 1024 * 1024;
export const WORKSPACE_FAVICON_MAX_BYTES = 1024 * 1024;
export const WORKSPACE_ASSET_HANDLE_TTL_MS = 5 * 60 * 1_000;

const MAX_ACTIVE_HANDLES = 2_048;

const IMAGE_MIME_BY_EXTENSION = new Map([
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

export type WorkspaceAssetAuthorizationFailure =
  | "expired_handle"
  | "identity_not_found"
  | "invalid_path"
  | "mime_mismatch"
  | "not_file"
  | "not_found"
  | "too_large";

export class WorkspaceAssetAuthorizationError extends Error {
  readonly failure: WorkspaceAssetAuthorizationFailure;

  constructor(failure: WorkspaceAssetAuthorizationFailure, message: string) {
    super(message);
    this.name = "WorkspaceAssetAuthorizationError";
    this.failure = failure;
  }
}

export interface AuthorizedWorkspaceImageAsset {
  readonly bytes: Uint8Array;
  readonly contentSha256: string;
  readonly identity: WorkspaceAssetIdentity;
  readonly mimeType: string;
  readonly relativePath: string;
}

export type WorkspaceAssetIdentity =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "thread"; readonly threadId: string };

export interface WorkspaceAssetHandle {
  readonly handle: string;
  readonly expiresAt: number;
}

interface HandleRecord {
  readonly identity: WorkspaceAssetIdentity;
  readonly relativePath: string;
  readonly maxBytes: number;
  readonly rejectSymlink: boolean;
  readonly expiresAt: number;
}

export interface WorkspaceAssetReader {
  readonly identity: WorkspaceAssetIdentity;
  readonly readImage: (input: {
    relativePath: string;
    maxBytes?: number;
    rejectSymlink?: boolean;
  }) => Promise<AuthorizedWorkspaceImageAsset>;
  readonly readText: (input: {
    relativePath: string;
    maxBytes: number;
    rejectSymlink?: boolean;
  }) => Promise<string>;
  readonly issueImageHandle: (input: {
    relativePath: string;
    maxBytes?: number;
    rejectSymlink?: boolean;
  }) => WorkspaceAssetHandle;
}

export interface WorkspaceAssetAuthorizer {
  readonly forProject: (projectId: string) => Promise<WorkspaceAssetReader>;
  readonly forThread: (threadId: string) => Promise<WorkspaceAssetReader>;
  readonly readHandle: (handle: string) => Promise<AuthorizedWorkspaceImageAsset>;
}

function isPathInside(rootRealPath: string, targetRealPath: string): boolean {
  const relative = path.relative(rootRealPath, targetRealPath);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function resolveRequestedPath(rootRealPath: string, relativePath: string): string {
  const normalized = relativePath.trim();
  if (normalized.length === 0 || normalized.includes("\0") || path.isAbsolute(normalized)) {
    throw new WorkspaceAssetAuthorizationError(
      "invalid_path",
      "Workspace asset path must be a non-empty relative path.",
    );
  }
  const requestedPath = path.resolve(rootRealPath, normalized);
  if (!isPathInside(rootRealPath, requestedPath) || requestedPath === rootRealPath) {
    throw new WorkspaceAssetAuthorizationError(
      "invalid_path",
      "Workspace asset path must stay within the registered project root.",
    );
  }
  return requestedPath;
}

function isSvg(bytes: Uint8Array): boolean {
  const prefix = Buffer.from(bytes.subarray(0, 16 * 1024))
    .toString("utf8")
    .replace(/^\uFEFF/u, "");
  const withoutPreamble = prefix
    .replace(/^\s*<\?xml[^>]*>\s*/iu, "")
    .replace(/^\s*<!doctype\s+svg[^>]*>\s*/iu, "")
    .replace(/^\s*<!--[\s\S]*?-->\s*/u, "");
  return /^\s*<svg(?:\s|>)/iu.test(withoutPreamble);
}

function detectedImageMimeType(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const sixByteHeader = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
  if (sixByteHeader === "GIF87a" || sixByteHeader === "GIF89a") {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) {
    return "image/x-icon";
  }
  return isSvg(bytes) ? "image/svg+xml" : null;
}

function normalizeMaxBytes(maxBytes: number): number {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > WORKSPACE_IMAGE_ASSET_MAX_BYTES
  ) {
    throw new WorkspaceAssetAuthorizationError("too_large", "Invalid workspace asset byte cap.");
  }
  return maxBytes;
}

async function readContainedFile(input: {
  rootPath: string;
  rootRealPath: string;
  relativePath: string;
  maxBytes: number;
  rejectSymlink?: boolean;
}): Promise<{ bytes: Uint8Array; relativePath: string }> {
  const requestedPath = resolveRequestedPath(input.rootRealPath, input.relativePath);
  let targetRealPath: string;
  try {
    targetRealPath = await realpath(requestedPath);
  } catch {
    throw new WorkspaceAssetAuthorizationError("not_found", "Workspace asset was not found.");
  }
  if (input.rejectSymlink === true && targetRealPath !== requestedPath) {
    throw new WorkspaceAssetAuthorizationError(
      "invalid_path",
      "Workspace asset path may not contain symbolic links.",
    );
  }
  if (!isPathInside(input.rootRealPath, targetRealPath)) {
    throw new WorkspaceAssetAuthorizationError(
      "invalid_path",
      "Workspace asset path resolves outside the registered project root.",
    );
  }

  const beforeStat = await lstat(targetRealPath).catch(() => null);
  if (!beforeStat) {
    throw new WorkspaceAssetAuthorizationError("not_found", "Workspace asset was not found.");
  }
  if (!beforeStat.isFile()) {
    throw new WorkspaceAssetAuthorizationError("not_file", "Workspace asset is not a file.");
  }
  if (beforeStat.size > input.maxBytes) {
    throw new WorkspaceAssetAuthorizationError(
      "too_large",
      "Workspace asset exceeds its byte cap.",
    );
  }

  const noFollowFlag = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const file = await open(targetRealPath, fsConstants.O_RDONLY | noFollowFlag).catch(() => null);
  if (!file) {
    throw new WorkspaceAssetAuthorizationError("not_found", "Workspace asset could not be opened.");
  }
  try {
    const openedStat = await file.stat();
    if (!openedStat.isFile()) {
      throw new WorkspaceAssetAuthorizationError("not_file", "Workspace asset is not a file.");
    }
    if (openedStat.size > input.maxBytes) {
      throw new WorkspaceAssetAuthorizationError(
        "too_large",
        "Workspace asset exceeds its byte cap.",
      );
    }
    if (
      beforeStat.dev !== 0 &&
      beforeStat.ino !== 0 &&
      (beforeStat.dev !== openedStat.dev || beforeStat.ino !== openedStat.ino)
    ) {
      throw new WorkspaceAssetAuthorizationError(
        "invalid_path",
        "Workspace asset changed while it was being authorized.",
      );
    }

    const [rootRealPathAfterOpen, targetRealPathAfterOpen] = await Promise.all([
      realpath(input.rootPath),
      realpath(requestedPath),
    ]).catch(() => [null, null] as const);
    if (
      rootRealPathAfterOpen !== input.rootRealPath ||
      targetRealPathAfterOpen !== targetRealPath ||
      targetRealPathAfterOpen === null ||
      !isPathInside(input.rootRealPath, targetRealPathAfterOpen)
    ) {
      throw new WorkspaceAssetAuthorizationError(
        "invalid_path",
        "Workspace asset changed while it was being authorized.",
      );
    }

    const bytes = await file.readFile();
    if (bytes.byteLength > input.maxBytes) {
      throw new WorkspaceAssetAuthorizationError(
        "too_large",
        "Workspace asset exceeds its byte cap.",
      );
    }
    return { bytes, relativePath: input.relativePath.trim().replaceAll("\\", "/") };
  } finally {
    await file.close();
  }
}

export function makeWorkspaceAssetAuthorizer(input: {
  resolveProjectWorkspaceRoot: (projectId: string) => Promise<string | null>;
  resolveThreadWorkspaceRoot?: (threadId: string) => Promise<string | null>;
  now?: () => number;
  handleTtlMs?: number;
  createHandle?: () => string;
}): WorkspaceAssetAuthorizer {
  const now = input.now ?? Date.now;
  const handleTtlMs = input.handleTtlMs ?? WORKSPACE_ASSET_HANDLE_TTL_MS;
  const createHandle = input.createHandle ?? (() => randomBytes(24).toString("base64url"));
  const handles = new Map<string, HandleRecord>();

  const pruneHandles = () => {
    const timestamp = now();
    for (const [handle, record] of handles) {
      if (record.expiresAt <= timestamp) handles.delete(handle);
    }
    while (handles.size >= MAX_ACTIVE_HANDLES) {
      const oldestHandle = handles.keys().next().value as string | undefined;
      if (!oldestHandle) break;
      handles.delete(oldestHandle);
    }
  };

  const forIdentity = async (
    identity: WorkspaceAssetIdentity,
    rootPath: string | null,
  ): Promise<WorkspaceAssetReader> => {
    if (!rootPath) {
      throw new WorkspaceAssetAuthorizationError(
        "identity_not_found",
        "Workspace asset identity is not registered.",
      );
    }
    const rootRealPath = await realpath(rootPath).catch(() => null);
    if (!rootRealPath) {
      throw new WorkspaceAssetAuthorizationError(
        "identity_not_found",
        "Registered workspace root is unavailable.",
      );
    }

    const readImage = async (assetInput: {
      relativePath: string;
      maxBytes?: number;
      rejectSymlink?: boolean;
    }): Promise<AuthorizedWorkspaceImageAsset> => {
      const maxBytes = normalizeMaxBytes(assetInput.maxBytes ?? WORKSPACE_IMAGE_ASSET_MAX_BYTES);
      const result = await readContainedFile({
        rootPath,
        rootRealPath,
        relativePath: assetInput.relativePath,
        maxBytes,
        ...(assetInput.rejectSymlink !== undefined
          ? { rejectSymlink: assetInput.rejectSymlink }
          : {}),
      });
      const extensionMimeType = IMAGE_MIME_BY_EXTENSION.get(
        path.extname(result.relativePath).toLowerCase(),
      );
      const signatureMimeType = detectedImageMimeType(result.bytes);
      if (!extensionMimeType || signatureMimeType !== extensionMimeType) {
        throw new WorkspaceAssetAuthorizationError(
          "mime_mismatch",
          "Workspace image MIME type does not match its extension and content signature.",
        );
      }
      return {
        bytes: result.bytes,
        contentSha256: createHash("sha256").update(result.bytes).digest("hex"),
        identity,
        mimeType: signatureMimeType,
        relativePath: result.relativePath,
      };
    };

    return {
      identity,
      readImage,
      readText: async ({ relativePath, maxBytes, rejectSymlink }) => {
        const result = await readContainedFile({
          rootPath,
          rootRealPath,
          relativePath,
          maxBytes: normalizeMaxBytes(maxBytes),
          ...(rejectSymlink !== undefined ? { rejectSymlink } : {}),
        });
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
        } catch {
          throw new WorkspaceAssetAuthorizationError(
            "mime_mismatch",
            "Workspace text asset is not valid UTF-8.",
          );
        }
      },
      issueImageHandle: ({ relativePath, maxBytes, rejectSymlink }) => {
        pruneHandles();
        let handle = createHandle();
        while (handles.has(handle)) handle = createHandle();
        const expiresAt = now() + handleTtlMs;
        handles.set(handle, {
          identity,
          relativePath,
          maxBytes: normalizeMaxBytes(maxBytes ?? WORKSPACE_IMAGE_ASSET_MAX_BYTES),
          rejectSymlink: rejectSymlink === true,
          expiresAt,
        });
        return { handle, expiresAt };
      },
    };
  };

  const forProject = async (projectId: string): Promise<WorkspaceAssetReader> =>
    forIdentity({ kind: "project", projectId }, await input.resolveProjectWorkspaceRoot(projectId));

  const forThread = async (threadId: string): Promise<WorkspaceAssetReader> =>
    forIdentity(
      { kind: "thread", threadId },
      input.resolveThreadWorkspaceRoot ? await input.resolveThreadWorkspaceRoot(threadId) : null,
    );

  return {
    forProject,
    forThread,
    readHandle: async (handle) => {
      const record = handles.get(handle);
      if (!record || record.expiresAt <= now()) {
        handles.delete(handle);
        throw new WorkspaceAssetAuthorizationError(
          "expired_handle",
          "Workspace asset handle is invalid or expired.",
        );
      }
      const reader =
        record.identity.kind === "project"
          ? await forProject(record.identity.projectId)
          : await forThread(record.identity.threadId);
      return reader.readImage({
        relativePath: record.relativePath,
        maxBytes: record.maxBytes,
        rejectSymlink: record.rejectSymlink,
      });
    },
  };
}
