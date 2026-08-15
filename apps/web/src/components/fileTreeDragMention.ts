import type { NativeApi, ProjectId } from "@t3tools/contracts";

import { serializeComposerMentionPath } from "../composer-editor-mentions";

export const F5_FILE_MENTION_MIME = "application/x-f5-file-mention";
const FILE_MENTION_PAYLOAD_VERSION = 1;
const MAX_IDENTITY_LENGTH = 256;
const MAX_RELATIVE_PATH_LENGTH = 512;

export interface FileTreeDragMentionPayload {
  readonly version: 1;
  readonly projectId: string;
  readonly workspaceIdentity: string;
  readonly relativePath: string;
}

interface FileMentionDataTransferReader {
  readonly types: ArrayLike<string>;
  getData(format: string): string;
}

interface FileMentionDataTransferWriter {
  effectAllowed: string;
  setData(format: string, value: string): void;
}

function hashWorkspaceKey(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

export function workspaceIdentityForRoot(projectId: ProjectId | string, workspaceRoot: string) {
  const normalizedRoot = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  return `f5w1:${hashWorkspaceKey(`${projectId}\u0000${normalizedRoot}`)}`;
}

export function normalizeFileMentionRelativePath(input: string): string | null {
  if (
    input.length === 0 ||
    input.length > MAX_RELATIVE_PATH_LENGTH ||
    input.includes("\0") ||
    input.includes("\\") ||
    input.startsWith("/") ||
    /^[A-Za-z]:/.test(input)
  ) {
    return null;
  }
  const segments = input.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return null;
  }
  return segments.join("/");
}

export function composerFileMention(relativePath: string): string | null {
  const normalized = normalizeFileMentionRelativePath(relativePath);
  return normalized === null ? null : `@${serializeComposerMentionPath(normalized)}`;
}

function isNonEmptyBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTITY_LENGTH;
}

export function serializeFileTreeDragMentionPayload(input: {
  projectId: ProjectId | string;
  workspaceIdentity: string;
  relativePath: string;
}): string | null {
  const relativePath = normalizeFileMentionRelativePath(input.relativePath);
  if (
    relativePath === null ||
    !isNonEmptyBoundedString(input.projectId) ||
    !isNonEmptyBoundedString(input.workspaceIdentity)
  ) {
    return null;
  }
  return JSON.stringify({
    version: FILE_MENTION_PAYLOAD_VERSION,
    projectId: input.projectId,
    workspaceIdentity: input.workspaceIdentity,
    relativePath,
  } satisfies FileTreeDragMentionPayload);
}

export function parseFileTreeDragMentionPayload(
  serialized: string,
): FileTreeDragMentionPayload | null {
  if (serialized.length === 0 || serialized.length > 2_048) return null;
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const relativePath =
    typeof candidate.relativePath === "string"
      ? normalizeFileMentionRelativePath(candidate.relativePath)
      : null;
  if (
    candidate.version !== FILE_MENTION_PAYLOAD_VERSION ||
    !isNonEmptyBoundedString(candidate.projectId) ||
    !isNonEmptyBoundedString(candidate.workspaceIdentity) ||
    relativePath === null
  ) {
    return null;
  }
  return {
    version: FILE_MENTION_PAYLOAD_VERSION,
    projectId: candidate.projectId,
    workspaceIdentity: candidate.workspaceIdentity,
    relativePath,
  };
}

export function dataTransferHasFileTreeMention(types: ArrayLike<string>): boolean {
  return Array.from(types).includes(F5_FILE_MENTION_MIME);
}

export function readFileTreeDragMention(
  transfer: FileMentionDataTransferReader,
): FileTreeDragMentionPayload | null {
  if (!dataTransferHasFileTreeMention(transfer.types)) return null;
  return parseFileTreeDragMentionPayload(transfer.getData(F5_FILE_MENTION_MIME));
}

export function writeFileTreeDragMention(
  transfer: FileMentionDataTransferWriter,
  input: {
    projectId: ProjectId | string;
    workspaceIdentity: string;
    relativePath: string;
  },
): boolean {
  const serialized = serializeFileTreeDragMentionPayload(input);
  const mention = composerFileMention(input.relativePath);
  if (serialized === null || mention === null) return false;
  transfer.effectAllowed = "copy";
  transfer.setData(F5_FILE_MENTION_MIME, serialized);
  transfer.setData("text/plain", `${mention} `);
  return true;
}

export async function authorizeFileTreeMention(input: {
  api: NativeApi;
  payload: FileTreeDragMentionPayload;
  expectedProjectId: ProjectId | string;
  expectedWorkspaceIdentity: string;
  workspaceRoot: string;
}): Promise<string> {
  if (
    input.payload.projectId !== input.expectedProjectId ||
    input.payload.workspaceIdentity !== input.expectedWorkspaceIdentity
  ) {
    throw new Error("The dragged file belongs to a different project or workspace.");
  }
  const result = await input.api.projects.authorizeEntry({
    cwd: input.workspaceRoot,
    relativePath: input.payload.relativePath,
    kind: "file",
  });
  const normalized = normalizeFileMentionRelativePath(result.relativePath);
  if (normalized === null || result.kind !== "file") {
    throw new Error("The dragged file is no longer available in this workspace.");
  }
  return normalized;
}

export async function authorizeComposerMentionPaths(input: {
  api: NativeApi;
  workspaceRoot: string;
  relativePaths: readonly string[];
}): Promise<void> {
  const uniquePaths = [...new Set(input.relativePaths)];
  await Promise.all(
    uniquePaths.map(async (relativePath) => {
      const normalized = normalizeFileMentionRelativePath(relativePath);
      if (normalized === null) {
        throw new Error(`Invalid file mention: ${relativePath}`);
      }
      await input.api.projects.authorizeEntry({
        cwd: input.workspaceRoot,
        relativePath: normalized,
      });
    }),
  );
}
