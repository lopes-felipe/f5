import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL_BY_PROVIDER, ProjectId, ThreadId } from "@t3tools/contracts";

import type { DraftThreadState } from "../composerDraftStore";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "../types";
import {
  buildLocalDraftThread,
  getProjectActiveThreadsWithPinnedDraft,
  getProjectThreadsWithDraft,
  getVisibleThreadsWithPinnedDraft,
  isDraftThreadId,
} from "./draftThreads";

function makeDraftThread(
  overrides: Partial<DraftThreadState> & { projectId?: ProjectId } = {},
): DraftThreadState {
  return {
    projectId: overrides.projectId ?? ProjectId.makeUnsafe("project-1"),
    createdAt: "2026-03-01T00:00:00.000Z",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    envMode: "local",
    ...overrides,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    model: "gpt-5-codex",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    commandExecutions: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    lastInteractionAt: "2026-03-01T00:00:00.000Z",
    estimatedContextTokens: null,
    modelContextWindowTokens: null,
    latestTurn: null,
    lastVisitedAt: undefined,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    detailsLoaded: true,
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    sessionNotes: null,
    threadReferences: [],
    ...overrides,
  };
}

describe("draftThreads", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps a draft thread into the shared Thread shape", () => {
    const result = buildLocalDraftThread({
      threadId: ThreadId.makeUnsafe("draft-1"),
      draftThread: makeDraftThread({
        createdAt: "2026-03-02T12:00:00.000Z",
        branch: "feature/draft",
        worktreePath: "/tmp/project-1-worktree",
        envMode: "worktree",
      }),
      projectModel: "gpt-5-codex",
      error: "Draft error",
    });

    expect(result).toMatchObject({
      id: "draft-1",
      projectId: "project-1",
      title: "New thread",
      model: "gpt-5-codex",
      session: null,
      error: "Draft error",
      createdAt: "2026-03-02T12:00:00.000Z",
      lastInteractionAt: "2026-03-02T12:00:00.000Z",
      lastVisitedAt: "2026-03-02T12:00:00.000Z",
      archivedAt: null,
      branch: "feature/draft",
      worktreePath: "/tmp/project-1-worktree",
      messages: [],
      activities: [],
      proposedPlans: [],
      tasks: [],
      turnDiffSummaries: [],
    });
  });

  it("falls back to the default codex model when the project model is absent", () => {
    const result = buildLocalDraftThread({
      threadId: ThreadId.makeUnsafe("draft-1"),
      draftThread: makeDraftThread(),
    });

    expect(result.model).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });

  it("injects one draft thread into its owning project", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const result = getProjectThreadsWithDraft({
      projectId,
      projectThreads: [makeThread({ id: ThreadId.makeUnsafe("thread-1"), projectId })],
      draftThread: {
        threadId: ThreadId.makeUnsafe("draft-1"),
        ...makeDraftThread({ projectId }),
      },
      projectModel: "gpt-5-codex",
    });

    expect(result.map((thread) => thread.id)).toEqual(["thread-1", "draft-1"]);
    expect(result[1]?.title).toBe("New thread");
  });

  it("does not inject a draft thread when none exists", () => {
    const threads = [makeThread({ id: ThreadId.makeUnsafe("thread-1") })];

    expect(
      getProjectThreadsWithDraft({
        projectId: ProjectId.makeUnsafe("project-1"),
        projectThreads: threads,
        draftThread: null,
      }),
    ).toEqual(threads);
  });

  it("does not inject a draft thread into a different project", () => {
    const threads = [makeThread({ id: ThreadId.makeUnsafe("thread-1") })];

    expect(
      getProjectThreadsWithDraft({
        projectId: ProjectId.makeUnsafe("project-1"),
        projectThreads: threads,
        draftThread: {
          threadId: ThreadId.makeUnsafe("draft-1"),
          ...makeDraftThread({ projectId: ProjectId.makeUnsafe("project-2") }),
        },
      }),
    ).toEqual(threads);
  });

  it("does not duplicate a draft after the persisted thread arrives", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const draftId = ThreadId.makeUnsafe("draft-1");

    const result = getProjectThreadsWithDraft({
      projectId,
      projectThreads: [makeThread({ id: draftId, projectId, title: "Persisted thread" })],
      draftThread: {
        threadId: draftId,
        ...makeDraftThread({ projectId }),
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe("Persisted thread");
  });

  it("leaves archived handling unchanged by keeping drafts active", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const archivedThread = makeThread({
      id: ThreadId.makeUnsafe("thread-archived"),
      projectId,
      archivedAt: "2026-03-03T00:00:00.000Z",
    });

    const result = getProjectThreadsWithDraft({
      projectId,
      projectThreads: [archivedThread],
      draftThread: {
        threadId: ThreadId.makeUnsafe("draft-1"),
        ...makeDraftThread({ projectId }),
      },
    });

    expect(result.find((thread) => thread.id === "thread-archived")?.archivedAt).toBe(
      "2026-03-03T00:00:00.000Z",
    );
    expect(result.find((thread) => thread.id === "draft-1")?.archivedAt).toBeNull();
  });

  it("pins a non-persisted draft ahead of newer active persisted threads", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const draftId = ThreadId.makeUnsafe("draft-1");

    const result = getProjectActiveThreadsWithPinnedDraft({
      projectId,
      projectThreads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-newer"),
          projectId,
          title: "Newer persisted thread",
          createdAt: "2026-03-03T00:00:00.000Z",
          lastInteractionAt: "2026-03-03T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-older"),
          projectId,
          title: "Older persisted thread",
          createdAt: "2026-03-02T00:00:00.000Z",
          lastInteractionAt: "2026-03-02T00:00:00.000Z",
        }),
      ],
      draftThread: {
        threadId: draftId,
        ...makeDraftThread({
          projectId,
          createdAt: "2026-03-01T00:00:00.000Z",
        }),
      },
      projectModel: "gpt-5-codex",
    });

    expect(result.map((thread) => thread.id)).toEqual([draftId, "thread-newer", "thread-older"]);
  });

  it("does not pin a draft after the persisted thread arrives", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const draftId = ThreadId.makeUnsafe("draft-1");

    const result = getProjectActiveThreadsWithPinnedDraft({
      projectId,
      projectThreads: [
        makeThread({
          id: draftId,
          projectId,
          title: "Persisted thread",
          createdAt: "2026-03-01T00:00:00.000Z",
          lastInteractionAt: "2026-03-01T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-newer"),
          projectId,
          title: "Newer persisted thread",
          createdAt: "2026-03-03T00:00:00.000Z",
          lastInteractionAt: "2026-03-03T00:00:00.000Z",
        }),
      ],
      draftThread: {
        threadId: draftId,
        ...makeDraftThread({
          projectId,
          createdAt: "2026-02-01T00:00:00.000Z",
        }),
      },
    });

    expect(result.map((thread) => thread.id)).toEqual(["thread-newer", draftId]);
  });

  it("pins a draft thread into the collapsed preview when it would otherwise be truncated", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeThread({
        id: ThreadId.makeUnsafe(`thread-${index}`),
        title: `Thread ${index}`,
      }),
    );
    const draftThread = makeThread({
      id: ThreadId.makeUnsafe("draft-1"),
      title: "New thread",
      createdAt: "2026-02-01T00:00:00.000Z",
      lastInteractionAt: "2026-02-01T00:00:00.000Z",
    });

    const visible = getVisibleThreadsWithPinnedDraft({
      threads: [...threads, draftThread],
      expanded: false,
      previewLimit: 6,
      draftThreadId: draftThread.id,
    });

    expect(visible).toHaveLength(6);
    expect(visible.map((thread) => thread.id)).toEqual([
      "thread-0",
      "thread-1",
      "thread-2",
      "thread-3",
      "thread-4",
      "draft-1",
    ]);
  });

  it("keeps the full list when the thread bucket is expanded", () => {
    const threads = [
      makeThread({ id: ThreadId.makeUnsafe("thread-1") }),
      makeThread({
        id: ThreadId.makeUnsafe("draft-1"),
        title: "New thread",
      }),
    ];

    expect(
      getVisibleThreadsWithPinnedDraft({
        threads,
        expanded: true,
        previewLimit: 1,
        draftThreadId: ThreadId.makeUnsafe("draft-1"),
      }).map((thread) => thread.id),
    ).toEqual(["thread-1", "draft-1"]);
  });

  it("keeps the normal preview when the draft is already visible", () => {
    const draftThread = makeThread({
      id: ThreadId.makeUnsafe("draft-1"),
      title: "New thread",
    });
    const threads = [
      makeThread({ id: ThreadId.makeUnsafe("thread-1") }),
      draftThread,
      makeThread({ id: ThreadId.makeUnsafe("thread-2") }),
    ];

    expect(
      getVisibleThreadsWithPinnedDraft({
        threads,
        expanded: false,
        previewLimit: 2,
        draftThreadId: draftThread.id,
      }).map((thread) => thread.id),
    ).toEqual(["thread-1", "draft-1"]);
  });

  it("keeps the normal preview when no draft id is provided", () => {
    const threads = [
      makeThread({ id: ThreadId.makeUnsafe("thread-1") }),
      makeThread({ id: ThreadId.makeUnsafe("thread-2") }),
      makeThread({ id: ThreadId.makeUnsafe("thread-3") }),
    ];

    expect(
      getVisibleThreadsWithPinnedDraft({
        threads,
        expanded: false,
        previewLimit: 2,
      }).map((thread) => thread.id),
    ).toEqual(["thread-1", "thread-2"]);
  });

  it("keeps the normal preview when the requested draft id is missing", () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const threads = [
      makeThread({ id: ThreadId.makeUnsafe("thread-1") }),
      makeThread({ id: ThreadId.makeUnsafe("thread-2") }),
      makeThread({ id: ThreadId.makeUnsafe("thread-3") }),
    ];

    expect(
      getVisibleThreadsWithPinnedDraft({
        threads,
        expanded: false,
        previewLimit: 2,
        draftThreadId: ThreadId.makeUnsafe("draft-missing"),
      }).map((thread) => thread.id),
    ).toEqual(["thread-1", "thread-2"]);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "Pinned draft thread was not found in the visible project thread list.",
      { draftThreadId: "draft-missing" },
    );
  });

  it("treats persisted thread ids as non-drafts during promotion", () => {
    const draftId = ThreadId.makeUnsafe("draft-1");

    expect(
      isDraftThreadId(draftId, { [draftId]: makeDraftThread() }, new Set<ThreadId>([draftId])),
    ).toBe(false);
    expect(isDraftThreadId(draftId, { [draftId]: makeDraftThread() })).toBe(true);
  });
});
