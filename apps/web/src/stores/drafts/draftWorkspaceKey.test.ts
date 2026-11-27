import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  type DraftThreadState,
  isProjectDraftKeyForProject,
  keyForDraftThread,
  projectIdFromDraftThreadKey,
  resolveDraftWorkspace,
  selectProjectDraftThread,
} from "./draftWorkspaceKey";

function makeDraft(overrides: Partial<DraftThreadState> = {}): DraftThreadState {
  return {
    projectId: ProjectId.make("proj-1"),
    createdAt: "2026-01-01T00:00:00.000Z",
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    envMode: "local",
    ...overrides,
  };
}

describe("draftWorkspaceKey", () => {
  it("parses both modern and legacy draft key separators", () => {
    const projectId = ProjectId.make("proj-1");
    expect(projectIdFromDraftThreadKey("proj-1::local")).toBe(projectId);
    expect(projectIdFromDraftThreadKey("proj-1::worktree:/tmp/wt")).toBe(projectId);
    expect(projectIdFromDraftThreadKey("proj-1\u0000worktree:/tmp/wt")).toBe(projectId);
    expect(isProjectDraftKeyForProject("proj-1\u0000local", projectId)).toBe(true);
    expect(isProjectDraftKeyForProject("proj-2::local", projectId)).toBe(false);
  });

  it("selects exact workspace drafts, skips promoting drafts, and picks the newest across legacy keys", () => {
    const proj1 = ProjectId.make("proj-1");
    const tLocal = ThreadId.make("draft-local");
    const tWorktree = ThreadId.make("draft-wt");
    const tPromoting = ThreadId.make("draft-promoting");

    const localDraft = makeDraft({
      projectId: proj1,
      createdAt: "2026-01-01T00:00:01.000Z",
      envMode: "local",
    });
    const worktreeDraft = makeDraft({
      projectId: proj1,
      createdAt: "2026-01-01T00:00:05.000Z",
      envMode: "worktree",
      worktreePath: "/repo/.wt/a",
    });
    const promotingDraft = makeDraft({
      projectId: proj1,
      createdAt: "2026-01-01T00:00:10.000Z",
      promoting: true,
    });

    const state = {
      draftThreadsByThreadId: {
        [tLocal]: localDraft,
        [tWorktree]: worktreeDraft,
        [tPromoting]: promotingDraft,
      } as Record<ThreadId, DraftThreadState>,
      projectDraftThreadIdByProjectId: {
        [keyForDraftThread(localDraft)]: tLocal,
        // Legacy null-byte separator key should still participate in project-wide fallback
        ["proj-1\u0000worktree:/repo/.wt/a"]: tWorktree,
        ["proj-1::worktree:new"]: tPromoting,
      },
    };

    expect(selectProjectDraftThread(state, proj1, { envMode: "local" })?.threadId).toBe(tLocal);
    expect(selectProjectDraftThread(state, proj1, { envMode: "worktree" })).toBeNull();
    expect(selectProjectDraftThread(state, proj1)?.threadId).toBe(tWorktree);
    expect(selectProjectDraftThread(state, ProjectId.makeUnsafe(""))).toBeNull();
  });

  it("resets branch and worktreePath when switching projects in resolveDraftWorkspace", () => {
    const existing = makeDraft({
      projectId: ProjectId.make("proj-1"),
      branch: "feat/old",
      worktreePath: "/tmp/old",
      envMode: "worktree",
    });
    expect(resolveDraftWorkspace(ProjectId.make("proj-2"), existing)).toEqual({
      branch: null,
      worktreePath: null,
      envMode: "worktree",
    });
  });
});
