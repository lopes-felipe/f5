import { describe, expect, it } from "vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";

import { parsePersistedAppSettings, type OnboardingLiteStatus } from "../appSettings";
import { deriveOnboardingLiteState } from "./onboardingLite";
import type { Project, Thread } from "../types";

const NOW_ISO = "2026-04-22T12:00:00.000Z";

function makeProject(id = "project-1"): Project {
  return {
    id: ProjectId.makeUnsafe(id),
    name: `Project ${id}`,
    cwd: `/repo/${id}`,
    model: "gpt-5.4",
    createdAt: NOW_ISO,
    expanded: true,
    scripts: [],
    memories: [],
    skills: [],
  };
}

function makeThread(projectId: Project["id"], id = "thread-1"): Thread {
  return {
    id: ThreadId.makeUnsafe(id),
    codexThreadId: null,
    projectId,
    title: "Thread",
    model: "gpt-5.4",
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    commandExecutions: [],
    proposedPlans: [],
    error: null,
    createdAt: NOW_ISO,
    archivedAt: null,
    lastInteractionAt: NOW_ISO,
    estimatedContextTokens: null,
    modelContextWindowTokens: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    compaction: null,
    turnDiffSummaries: [],
    activities: [],
    detailsLoaded: false,
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    sessionNotes: null,
    threadReferences: [],
  };
}

function deriveState(input?: {
  status?: OnboardingLiteStatus;
  projects?: ReadonlyArray<Project>;
  threads?: ReadonlyArray<Thread>;
  draftThreadsByProjectId?: ReadonlyMap<string, string>;
  threadsHydrated?: boolean;
  recoveryEpoch?: number;
}) {
  return deriveOnboardingLiteState({
    settings: {
      ...parsePersistedAppSettings(null),
      onboardingLiteStatus: input?.status ?? "eligible",
    },
    projects: input?.projects ?? [],
    threads: input?.threads ?? [],
    draftThreadsByProjectId: input?.draftThreadsByProjectId ?? new Map(),
    threadsHydrated: input?.threadsHydrated ?? true,
    recoveryEpoch: input?.recoveryEpoch ?? 1,
  });
}

describe("deriveOnboardingLiteState", () => {
  it("stays loading until both hydration and recovery are complete", () => {
    expect(deriveState({ threadsHydrated: false, recoveryEpoch: 1 }).mode).toBe("loading");
    expect(deriveState({ threadsHydrated: true, recoveryEpoch: 0 }).mode).toBe("loading");
  });

  it("shows onboarding for first-time users with no projects", () => {
    expect(deriveState({ status: "eligible" }).mode).toBe("onboarding");
  });

  it("shows the neutral empty-projects state after dismissal or completion", () => {
    expect(deriveState({ status: "dismissed" }).mode).toBe("empty-projects");
    expect(deriveState({ status: "completed" }).mode).toBe("empty-projects");
  });

  it("shows onboarding again after an explicit reset even for populated users", () => {
    const project = makeProject();

    const state = deriveState({
      status: "reopened",
      projects: [project],
      threads: [makeThread(project.id)],
    });

    expect(state.mode).toBe("onboarding");
    expect(state.shouldPromoteToCompleted).toBe(false);
  });

  it("excludes orphaned draft thread mappings from the valid draft count", () => {
    const state = deriveState({
      projects: [makeProject("project-live")],
      draftThreadsByProjectId: new Map([
        ["project-live", "thread-live"],
        ["project-deleted", "thread-orphan"],
      ]),
    });

    expect(state.validDraftThreadCount).toBe(1);
  });

  it("includes valid project-backed draft threads when deriving completion", () => {
    const project = makeProject();

    const state = deriveState({
      projects: [project],
      draftThreadsByProjectId: new Map([[project.id, "draft-thread-1"]]),
    });

    expect(state.mode).toBe("empty-threads");
    expect(state.validDraftThreadCount).toBe(1);
    expect(state.shouldPromoteToCompleted).toBe(true);
  });

  it("requires a project and either a real thread or a valid draft thread before promoting completion", () => {
    const project = makeProject();

    expect(deriveState({ projects: [project] }).shouldPromoteToCompleted).toBe(false);
    expect(
      deriveState({
        projects: [project],
        threads: [makeThread(project.id)],
      }).shouldPromoteToCompleted,
    ).toBe(true);
  });

  it("never regresses out of completed once the status is stored", () => {
    const project = makeProject();

    const state = deriveState({
      status: "completed",
      projects: [project],
      threads: [makeThread(project.id)],
    });

    expect(state.status).toBe("completed");
    expect(state.shouldPromoteToCompleted).toBe(false);
  });
});
