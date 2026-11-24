/**
 * Antigravity writes its plans, task lists and walkthroughs as "artifacts" in
 * the conversation's brain directory
 * (`<profile>/antigravity-acp/brain/<sessionId>/`). An artifact whose metadata
 * requests feedback is the plan the user is asked to review.
 *
 * @module provider/acp/AntigravityPlanArtifacts
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { AcpToolCallState } from "./AcpRuntimeModel.ts";

/** A plan larger than this is read from the captured write instead. */
export const ANTIGRAVITY_PLAN_READ_LIMIT_BYTES = 512 * 1024;

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The brain root, under the profile path as given and as resolved (macOS `/var` → `/private/var`). */
export function antigravityBrainRoots(profileDirectory: string): ReadonlyArray<string> {
  const roots = [NodePath.resolve(profileDirectory)];
  try {
    roots.push(NodeFS.realpathSync(profileDirectory));
  } catch {
    // The profile may not exist yet; the path as given still matches.
  }
  return [...new Set(roots)].map((root) => NodePath.join(root, "antigravity-acp", "brain"));
}

/**
 * `ArtifactMetadata.RequestFeedback`, from the object Antigravity sends or the
 * Python-style string some versions send (`{'RequestFeedback': True, ...}`).
 */
export function antigravityArtifactRequestsFeedback(metadata: unknown): boolean {
  if (typeof metadata === "string")
    return /['"]RequestFeedback['"]\s*:\s*(?:True|true)\b/.test(metadata);
  return record(metadata).RequestFeedback === true;
}

/**
 * Whether a tool call writes a file. Antigravity reports its native write tools
 * as `kind: "other"` at first, so the title and the artifact metadata count too;
 * reads and searches of brain files (`view_file` of `task.md`) never do.
 */
function isWriteCall(tool: AcpToolCallState): boolean {
  if (tool.kind === "edit") return true;
  if (tool.kind && tool.kind !== "other") return false;
  return (
    /(?:write_to_file|replace_file_content)/.test(tool.title ?? "") ||
    record(tool.data.rawInput).ArtifactMetadata !== undefined
  );
}

/** The file an edit tool call writes, from its input or its reported location. */
function editedPath(tool: AcpToolCallState): string | undefined {
  const raw = record(tool.data.rawInput);
  for (const value of [raw.Path, raw.TargetFile, raw.path, raw.file_path])
    if (typeof value === "string" && value.trim()) return value.trim();
  const locations = Array.isArray(tool.data.locations) ? tool.data.locations : [];
  const location = record(locations[0]).path;
  return typeof location === "string" && location.trim() ? location.trim() : undefined;
}

export interface AntigravityArtifactWrite {
  readonly path: string;
  readonly basename: string;
  /** The conversation the artifact belongs to: the first directory under the brain root. */
  readonly conversationId: string;
  readonly requestsFeedback: boolean;
  /** The full content the write sent, when it carried one. */
  readonly content: string | undefined;
}

/** A write into a brain directory, or undefined for every other tool call. */
export function antigravityArtifactWrite(
  tool: AcpToolCallState,
  brainRoots: ReadonlyArray<string>,
): AntigravityArtifactWrite | undefined {
  if (brainRoots.length === 0 || !isWriteCall(tool)) return undefined;
  const target = editedPath(tool);
  if (!target || !NodePath.isAbsolute(target)) return undefined;
  const path = NodePath.resolve(target);
  for (const root of brainRoots) {
    const relative = NodePath.relative(root, path);
    if (!relative || relative.startsWith("..") || NodePath.isAbsolute(relative)) continue;
    const [conversationId, ...rest] = relative.split(NodePath.sep);
    if (!conversationId || rest.length === 0) return undefined;
    const raw = record(tool.data.rawInput);
    const content = [raw.Content, raw.CodeContent, raw.content].find(
      (value): value is string => typeof value === "string",
    );
    return {
      path,
      basename: NodePath.basename(path),
      conversationId,
      requestsFeedback: antigravityArtifactRequestsFeedback(raw.ArtifactMetadata),
      content,
    };
  }
  return undefined;
}

/**
 * The newest feedback-requesting artifact one turn wrote into its own
 * conversation's brain directory. Fed raw tool calls, before sanitization
 * trims their text. A write counts only once its call completes, so a write
 * that fails never becomes the proposed plan.
 */
export class AntigravityPlanArtifactTracker {
  private latest: AntigravityArtifactWrite | undefined;
  /** Feedback writes still running, by tool call. */
  private readonly running = new Map<string, AntigravityArtifactWrite>();

  constructor(readonly brainRoots: ReadonlyArray<string>) {}

  reset(): void {
    this.latest = undefined;
    this.running.clear();
  }

  observe(tool: AcpToolCallState, conversationId: string): void {
    if (tool.status === "failed") {
      this.running.delete(tool.toolCallId);
      return;
    }
    const write = antigravityArtifactWrite(tool, this.brainRoots);
    if (write && write.conversationId === conversationId && write.requestsFeedback) {
      // Updates of one call often drop the content; keep what an earlier update carried.
      const earlier = this.running.get(tool.toolCallId);
      this.running.set(tool.toolCallId, {
        ...write,
        content: write.content ?? (earlier?.path === write.path ? earlier.content : undefined),
      });
      if (this.running.size > 64) this.running.delete(this.running.keys().next().value!);
    }
    if (tool.status !== "completed") return;
    const completed = this.running.get(tool.toolCallId);
    this.running.delete(tool.toolCallId);
    if (completed) this.latest = completed;
  }

  take(): AntigravityArtifactWrite | undefined {
    const latest = this.latest;
    this.reset();
    return latest;
  }
}

/** The longest prefix of `text` that fits in `limit` UTF-8 bytes, never splitting a character. */
export function truncateUtf8(text: string, limit: number): string {
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  const { read } = new TextEncoder().encodeInto(text, new Uint8Array(limit));
  return text.slice(0, read);
}

const isInside = (root: string, path: string) => {
  const relative = NodePath.relative(root, path);
  return !!relative && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
};

/**
 * The artifact's text on disk, bounded; falls back to the content the write
 * carried. The read refuses a symlinked file (`O_NOFOLLOW`) and a directory
 * that resolves outside the brain root, and never reads past the limit, even
 * when the file changes between the checks and the read.
 */
export async function readAntigravityPlanArtifact(
  write: AntigravityArtifactWrite,
  brainRoots: ReadonlyArray<string>,
): Promise<string | undefined> {
  const limit = ANTIGRAVITY_PLAN_READ_LIMIT_BYTES;
  try {
    const directory = await NodeFSP.realpath(NodePath.dirname(write.path));
    const roots = await Promise.all(
      brainRoots.map((root) => NodeFSP.realpath(root).catch(() => root)),
    );
    if (roots.some((root) => isInside(root, directory))) {
      const handle = await NodeFSP.open(
        NodePath.join(directory, NodePath.basename(write.path)),
        NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
      );
      try {
        const info = await handle.stat();
        if (info.isFile() && info.size <= limit) {
          const buffer = Buffer.alloc(limit + 1);
          let length = 0;
          while (length < buffer.length) {
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
            if (bytesRead === 0) break;
            length += bytesRead;
          }
          const text = length <= limit ? buffer.subarray(0, length).toString("utf8") : "";
          if (text.trim()) return text;
        }
      } finally {
        await handle.close();
      }
    }
  } catch {
    // Fall through to the captured content.
  }
  return write.content?.trim() ? truncateUtf8(write.content, limit) : undefined;
}
