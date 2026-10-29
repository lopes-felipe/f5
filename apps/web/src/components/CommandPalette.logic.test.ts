import { describe, expect, it, vi } from "vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import type { Thread } from "../types";
import {
  buildCommandPaletteRows,
  buildFileSearchActionItems,
  buildNestedSearchItems,
  buildThreadActionItems,
  filterCommandPaletteGroups,
  findHighlightedCommandPaletteItem,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
} from "./CommandPalette.logic";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: PROJECT_ID,
    title: "Thread",
    model: "gpt-5",
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    commandExecutions: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    lastInteractionAt: "2026-03-01T00:00:00.000Z",
    estimatedContextTokens: null,
    estimatedThinkingTokens: null,
    modelContextWindowTokens: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    detailsLoaded: false,
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    ...overrides,
  };
}

describe("buildThreadActionItems", () => {
  it("orders threads by most recent activity and formats timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T12:00:00.000Z"));

    try {
      const items = buildThreadActionItems({
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("thread-older"),
            title: "Older thread",
            lastInteractionAt: "2026-03-24T12:00:00.000Z",
          }),
          makeThread({
            id: ThreadId.makeUnsafe("thread-newer"),
            title: "Newer thread",
            createdAt: "2026-03-20T00:00:00.000Z",
            lastInteractionAt: "2026-03-20T00:00:00.000Z",
          }),
        ],
        projectTitleById: new Map([[PROJECT_ID, "Project"]]),
        icon: null,
        runThread: async (_thread) => undefined,
      });

      expect(items.map((item) => item.value)).toEqual([
        "thread:thread-older",
        "thread:thread-newer",
      ]);
      expect(items[0]?.timestamp).toBe("1d ago");
      expect(items[1]?.timestamp).toBe("5d ago");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ranks thread title matches ahead of contextual project-name matches", () => {
    const threadItems = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-context-match"),
          title: "Fix navbar spacing",
          lastInteractionAt: "2026-03-20T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-title-match"),
          title: "Project kickoff notes",
          createdAt: "2026-03-02T00:00:00.000Z",
          lastInteractionAt: "2026-03-19T00:00:00.000Z",
        }),
      ],
      projectTitleById: new Map([[PROJECT_ID, "Project"]]),
      icon: null,
      runThread: async (_thread) => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "project",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: threadItems,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.value).toBe("threads-search");
    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "thread:thread-title-match",
      "thread:thread-context-match",
    ]);
  });

  it("preserves thread project-name matches when there is no stronger title match", () => {
    const group: CommandPaletteGroup = {
      value: "threads-search",
      label: "Threads",
      items: [
        {
          kind: "action",
          value: "thread:project-context-only",
          searchTerms: ["Fix navbar spacing", "Project"],
          title: "Fix navbar spacing",
          description: "Project",
          icon: null,
          run: async () => undefined,
        },
      ],
    };

    const groups = filterCommandPaletteGroups({
      activeGroups: [group],
      query: "project",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: [],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map((item) => item.value)).toEqual(["thread:project-context-only"]);
  });

  it("filters archived threads out of thread search items", () => {
    const items = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-active"),
          title: "Active thread",
          createdAt: "2026-03-02T00:00:00.000Z",
          lastInteractionAt: "2026-03-19T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-archived"),
          title: "Archived thread",
          archivedAt: "2026-03-20T00:00:00.000Z",
          lastInteractionAt: "2026-03-20T00:00:00.000Z",
        }),
      ],
      projectTitleById: new Map([[PROJECT_ID, "Project"]]),
      icon: null,
      runThread: async (_thread) => undefined,
    });

    expect(items.map((item) => item.value)).toEqual(["thread:thread-active"]);
  });
});

describe("buildNestedSearchItems", () => {
  const action = (value: string, title: string): CommandPaletteActionItem => ({
    kind: "action",
    value,
    searchTerms: [title, `/path/${title}`],
    title,
    icon: null,
    run: async () => undefined,
  });
  const projects = [action("new-thread-in:f5", "f5"), action("new-thread-in:web", "web")];
  const newThreadIn = {
    kind: "submenu" as const,
    value: "action:new-thread-in",
    searchTerms: ["new thread"],
    title: "New thread in...",
    icon: null,
    addonIcon: null,
    groups: [{ value: "projects", label: "Projects", items: projects }],
  };
  const themes = {
    kind: "submenu" as const,
    value: "action:theme-picker",
    searchTerms: ["theme"],
    title: "Choose theme",
    icon: null,
    addonIcon: null,
    groups: [
      {
        value: "themes",
        label: "Themes",
        items: ["Dracula", "Nord", "Solarized", "Monokai"].map((name) =>
          action(`theme:${name}`, name),
        ),
      },
    ],
  };
  const addProject = action("action:add-project", "Add project");
  const rootItems = [newThreadIn, themes, addProject];
  const rootGroups: CommandPaletteGroup[] = [
    { value: "actions", label: "Actions", items: rootItems },
  ];
  const search = (query: string, isInSubmenu: boolean) =>
    filterCommandPaletteGroups({
      activeGroups: isInSubmenu ? newThreadIn.groups : rootGroups,
      query,
      isInSubmenu,
      allOptions: { rootGroups, nestedItems: buildNestedSearchItems(rootItems, query) },
      projectSearchItems: [],
      threadSearchItems: [],
    }).map((group) => [group.label, group.items.map((item) => item.title)]);

  it("joins submenu options to the root search with their parent's name", () => {
    expect(search("new thread in f5", false)).toEqual([["Suggestions", ["New thread in f5"]]]);
    expect(search("dracula", false)).toEqual([["Suggestions", ["Choose theme: Dracula"]]]);
  });

  it("leaves the submenu row alone when the query only names it", () => {
    expect(search("new thread", false)).toEqual([["Actions", ["New thread in..."]]]);
  });

  it("matches only the combined title and shows at most three", () => {
    expect(search("/path/", false).map(([label]) => label)).toEqual(["Actions"]);
    expect(search("choose theme:", false)[0]?.[1]).toHaveLength(3);
  });

  it("falls back to the full search from a submenu with no match", () => {
    expect(search("f5", true)).toEqual([["Projects", ["f5"]]]);
    expect(search("add project", true)).toEqual([["Actions", ["Add project"]]]);
    expect(search("", true)).toEqual([["Projects", ["f5", "web"]]]);
  });
});

describe("buildFileSearchActionItems", () => {
  it("builds file actions, skips directories, and preserves backend order", async () => {
    const runFile = vi.fn(async (_relativePath: string) => undefined);

    const items = buildFileSearchActionItems({
      entries: [
        { path: "apps/web/src/components/CommandPalette.tsx", kind: "file" },
        { path: "apps/web/src/components", kind: "directory" },
        { path: "README.md", kind: "file" },
      ],
      icon: null,
      runFile,
    });

    expect(items.map((item) => item.value)).toEqual([
      "file:apps/web/src/components/CommandPalette.tsx",
      "file:README.md",
    ]);
    expect(items[0]?.title).toBe("CommandPalette.tsx");
    expect(items[0]?.description).toBe("apps/web/src/components");
    expect(items[1]?.title).toBe("README.md");
    expect(items[1]?.description).toBeUndefined();

    await items[0]?.run();

    expect(runFile).toHaveBeenCalledWith("apps/web/src/components/CommandPalette.tsx");
  });

  it("uses dedicated file and content modes without mixing root actions", () => {
    const fileItem = buildFileSearchActionItems({
      entries: [{ path: "src/index.ts", kind: "file" }],
      icon: null,
      runFile: async () => undefined,
    })[0]!;
    const contentItem = {
      kind: "action" as const,
      value: "content:src/index.ts:1",
      searchTerms: ["needle"],
      title: "needle",
      icon: null,
      run: async () => undefined,
    };
    const rootGroup: CommandPaletteGroup = {
      value: "actions",
      label: "Actions",
      items: [contentItem],
    };

    expect(
      filterCommandPaletteGroups({
        activeGroups: [rootGroup],
        query: "",
        isInSubmenu: false,
        searchMode: "files",
        fileSearchItems: [fileItem],
        contentSearchItems: [contentItem],
        projectSearchItems: [],
        threadSearchItems: [],
      }).map((group) => group.value),
    ).toEqual(["files-search"]);
    expect(
      filterCommandPaletteGroups({
        activeGroups: [rootGroup],
        query: "needle",
        isInSubmenu: false,
        searchMode: "content",
        fileSearchItems: [fileItem],
        contentSearchItems: [contentItem],
        projectSearchItems: [],
        threadSearchItems: [],
      }).map((group) => group.value),
    ).toEqual(["project-content-search"]);
  });

  it("keeps backend-ranked file items even when the query is a typo", () => {
    const fileItems = buildFileSearchActionItems({
      entries: [{ path: "apps/web/src/components/CommandPalette.tsx", kind: "file" }],
      icon: null,
      runFile: async (_relativePath) => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "cmmand palete",
      isInSubmenu: false,
      fileSearchItems: fileItems,
      projectSearchItems: [],
      threadSearchItems: [],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.value).toBe("files-search");
    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "file:apps/web/src/components/CommandPalette.tsx",
    ]);
  });
});

describe("virtualized command palette rows", () => {
  const action = (value: string): CommandPaletteActionItem => ({
    kind: "action",
    value,
    searchTerms: [],
    title: value,
    icon: null,
    run: async () => {},
  });
  const groups: CommandPaletteGroup[] = [
    { value: "actions", label: "Actions", items: [action("new-thread")] },
    { value: "threads", label: "Threads", items: [action("thread-a"), action("thread-b")] },
  ];

  it("keeps group order and headings while indexing every item", () => {
    const { rows, itemValues, rowIndexByItemIndex } = buildCommandPaletteRows(groups);

    expect(rows.map((row) => (row.kind === "label" ? `# ${row.label}` : row.key))).toEqual([
      "# Actions",
      "actions:new-thread",
      "# Threads",
      "threads:thread-a",
      "threads:thread-b",
    ]);
    expect(itemValues).toEqual(["new-thread", "thread-a", "thread-b"]);
    expect(rowIndexByItemIndex).toEqual([1, 3, 4]);
    expect(rows.flatMap((row) => (row.kind === "item" ? [row.itemIndex] : []))).toEqual([0, 1, 2]);
  });

  it("resolves Enter to the highlighted item without needing its row mounted", () => {
    expect(findHighlightedCommandPaletteItem(groups, "thread-b")?.value).toBe("thread-b");
    expect(findHighlightedCommandPaletteItem(groups, "missing")).toBeNull();
    expect(findHighlightedCommandPaletteItem(groups, null)).toBeNull();
  });
});
