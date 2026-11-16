import { createHash } from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import { SCRATCH_DIRECTORY_NAME } from "@t3tools/shared/scratchProject";

import { runProcess } from "../processRunner";

/** Versioned so a future layout can mint a different id without colliding with this one. */
const SCRATCH_PROJECT_NAMESPACE = "f5.scratch-project.v1";

/**
 * The profile's scratch project id. It depends only on the profile, so concurrent creates,
 * retries and replays all name the same project. Shaped like a version 5 UUID.
 */
export function scratchProjectIdFor(profileId: string): string {
  const bytes = Buffer.from(
    createHash("sha1")
      .update(`${SCRATCH_PROJECT_NAMESPACE}\u0000${profileId}`)
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export function scratchRootFor(stateDir: string): string {
  return NodePath.join(stateDir, SCRATCH_DIRECTORY_NAME);
}

const SCRATCH_FOLDER_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Why a request naming `cwd` must be refused, or null. Below the scratch root only a thread's
 * own folder (and what is inside it) is a workspace, the shared root never is, and none of it
 * is a Git repository.
 */
export function scratchWorkspaceRefusal(input: {
  readonly scratchRoot: string;
  readonly method: string;
  readonly cwd: string;
}): string | null {
  const relative = NodePath.relative(
    NodePath.resolve(input.scratchRoot),
    NodePath.resolve(input.cwd),
  );
  if (
    relative === ".." ||
    relative.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relative)
  )
    return null;
  if (input.method.startsWith("git.")) return "Threads without a project have no Git repository.";
  const folder = relative.split(NodePath.sep)[0] ?? "";
  return SCRATCH_FOLDER_SEGMENT.test(folder)
    ? null
    : "The shared folder for threads without a project is not a workspace. Use the thread's own folder.";
}

/**
 * Whether `dir` is inside a Git checkout or Git directory. Without Git installed no folder
 * can be one, so that reads as outside; any other failure is unknown.
 */
export async function gitCheckoutState(dir: string): Promise<"inside" | "outside" | "unknown"> {
  try {
    const result = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: dir,
      env: process.env,
      allowNonZeroExit: true,
      timeoutMs: 5_000,
      maxBufferBytes: 4_096,
    });
    if (result.code === 0) return "inside";
    return /not a git repository/i.test(result.stderr) ? "outside" : "unknown";
  } catch (cause) {
    return cause instanceof Error && cause.message.startsWith("Command not found")
      ? "outside"
      : "unknown";
  }
}

/**
 * Creates the scratch root under the profile's state directory. A scratch folder inside a
 * checkout would inherit that repository's status and checkpoints, so it is refused there,
 * and when that cannot be ruled out.
 */
export async function prepareScratchRoot(stateDir: string): Promise<string> {
  await NodeFS.mkdir(stateDir, { recursive: true });
  const state = await gitCheckoutState(stateDir);
  if (state === "inside")
    throw new Error(
      "Threads without a project are unavailable because F5's data folder is inside a Git checkout.",
    );
  if (state === "unknown")
    throw new Error("Could not confirm that F5's data folder is outside a Git checkout.");
  const root = scratchRootFor(stateDir);
  await NodeFS.mkdir(root, { recursive: true });
  return root;
}
