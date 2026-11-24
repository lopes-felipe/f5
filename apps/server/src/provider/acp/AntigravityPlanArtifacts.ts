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
  if (brainRoots.length === 0) return undefined;
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
 * trims their text.
 */
export class AntigravityPlanArtifactTracker {
  private latest: AntigravityArtifactWrite | undefined;

  constructor(private readonly brainRoots: ReadonlyArray<string>) {}

  reset(): void {
    this.latest = undefined;
  }

  observe(tool: AcpToolCallState, conversationId: string): void {
    if (tool.status === "failed") return;
    const write = antigravityArtifactWrite(tool, this.brainRoots);
    if (!write || write.conversationId !== conversationId || !write.requestsFeedback) return;
    // Updates of one call often drop the content; keep what an earlier update carried.
    this.latest = {
      ...write,
      content:
        write.content ?? (this.latest?.path === write.path ? this.latest.content : undefined),
    };
  }

  take(): AntigravityArtifactWrite | undefined {
    const latest = this.latest;
    this.latest = undefined;
    return latest;
  }
}

/** The artifact's text on disk, bounded; falls back to the content the write carried. */
export async function readAntigravityPlanArtifact(
  write: AntigravityArtifactWrite,
): Promise<string | undefined> {
  try {
    const info = await NodeFSP.lstat(write.path);
    if (info.isFile() && info.size <= ANTIGRAVITY_PLAN_READ_LIMIT_BYTES) {
      const text = await NodeFSP.readFile(write.path, "utf8");
      if (text.trim()) return text;
    }
  } catch {
    // Fall through to the captured content.
  }
  return write.content?.trim()
    ? write.content.slice(0, ANTIGRAVITY_PLAN_READ_LIMIT_BYTES)
    : undefined;
}
