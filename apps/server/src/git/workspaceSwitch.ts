import { ServiceMap } from "effect";
import type { Effect } from "effect";

export type GitWorkspaceSwitchHandler = (input: {
  cwd: string;
  branch: string;
  create: boolean;
}) => Effect.Effect<void, Error>;
/** Transport-owned callback keeps Git workflows independent of orchestration services. */
export const GitWorkspaceSwitch = ServiceMap.Reference<null | GitWorkspaceSwitchHandler>(
  "t3/git/GitWorkspaceSwitch",
  { defaultValue: () => null },
);

/** Stable transport classification for checkouts that require isolation instead. */
export class WorkspaceRequiresNewWorktreeError extends Error {
  readonly code = "WorkspaceRequiresNewWorktree";
}
