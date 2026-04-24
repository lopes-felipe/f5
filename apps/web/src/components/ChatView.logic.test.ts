import { ProjectId, ThreadId, type ProjectSkill } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  buildComposerSkillReplacement,
  buildSlashComposerMenuItems,
  buildFirstSendBootstrap,
  buildExpiredTerminalContextToastCopy,
  createCachedAbsolutePathComparisonNormalizer,
  deriveComposerSendState,
  deriveProviderRuntimeInfoEntries,
  identityAbsolutePathNormalizer,
  readAttachedFileAbsolutePath,
  resolveAttachedFileReferencePaths,
  rewriteComposerRuntimeSkillInvocationForSend,
  shouldRenderTimelineContent,
} from "./ChatView.logic";

function createProjectSkill(overrides: Partial<ProjectSkill> = {}): ProjectSkill {
  return {
    id: "project-1:skill:review",
    projectId: ProjectId.makeUnsafe("project-1"),
    scope: "project",
    commandName: "review",
    displayName: null,
    description: "Review the diff",
    argumentHint: "<target>",
    allowedTools: [],
    paths: [],
    updatedAt: "2026-04-16T12:00:00.000Z",
    ...overrides,
  };
}

describe("buildSlashComposerMenuItems", () => {
  it("shows Codex runtime skills in the slash menu", () => {
    expect(
      buildSlashComposerMenuItems({
        query: "",
        provider: "codex",
        runtimeSlashCommands: [
          {
            name: "review",
            description: "Review the diff",
            argumentHint: "<target>",
          },
        ],
      }),
    ).toEqual([
      {
        id: "slash:model",
        type: "slash-command",
        command: "model",
        label: "/model",
        description: "Switch response model for this thread",
      },
      {
        id: "slash:plan",
        type: "slash-command",
        command: "plan",
        label: "/plan",
        description: "Switch this thread into plan mode",
      },
      {
        id: "slash:default",
        type: "slash-command",
        command: "default",
        label: "/default",
        description: "Switch this thread back to normal chat mode",
      },
      {
        id: "skill:runtime:review",
        type: "skill",
        name: "review",
        label: "/review",
        description: "Review the diff",
        argumentHint: "<target>",
      },
    ]);
  });

  it("keeps Claude project skills hidden on Codex", () => {
    const items = buildSlashComposerMenuItems({
      query: "",
      provider: "codex",
      projectSkills: [createProjectSkill()],
    });

    expect(items.some((item) => item.type === "skill")).toBe(false);
  });

  it("shows pathless Claude project skills on Claude threads", () => {
    const items = buildSlashComposerMenuItems({
      query: "",
      provider: "claudeAgent",
      projectSkills: [createProjectSkill()],
    });

    expect(items).toContainEqual({
      id: "skill:project:review",
      type: "skill",
      name: "review",
      label: "/review",
      description: "Review the diff",
      argumentHint: "<target>",
    });
  });

  it("keeps path-scoped project skills out of the slash menu", () => {
    const items = buildSlashComposerMenuItems({
      query: "",
      provider: "claudeAgent",
      projectSkills: [
        createProjectSkill({
          id: "project-1:skill:path-scoped",
          commandName: "path-scoped",
          paths: ["src/**"],
        }),
      ],
    });

    expect(items.some((item) => item.type === "skill")).toBe(false);
  });

  it("never surfaces reserved host command names as skills", () => {
    const items = buildSlashComposerMenuItems({
      query: "",
      provider: "codex",
      runtimeSlashCommands: [
        {
          name: "plan",
          description: "Should stay host-local",
        },
      ],
      projectSkills: [
        createProjectSkill({
          commandName: "default",
          description: "Should stay host-local",
        }),
      ],
    });

    expect(items.map((item) => item.label)).toEqual(["/model", "/plan", "/default"]);
  });

  it("drops runtime skills that cannot round-trip through the slash UI", () => {
    expect(
      buildSlashComposerMenuItems({
        query: "",
        provider: "codex",
        runtimeSlashCommands: [
          {
            name: "review diff",
            description: "Contains whitespace",
          },
          {
            name: "$review",
            description: "Contains a sigil",
          },
          {
            name: "Plan",
            description: "Collides with a reserved host command",
          },
          {
            name: "review",
            description: "Review the diff",
          },
        ],
      }),
    ).toEqual([
      {
        id: "slash:model",
        type: "slash-command",
        command: "model",
        label: "/model",
        description: "Switch response model for this thread",
      },
      {
        id: "slash:plan",
        type: "slash-command",
        command: "plan",
        label: "/plan",
        description: "Switch this thread into plan mode",
      },
      {
        id: "slash:default",
        type: "slash-command",
        command: "default",
        label: "/default",
        description: "Switch this thread back to normal chat mode",
      },
      {
        id: "skill:runtime:review",
        type: "skill",
        name: "review",
        label: "/review",
        description: "Review the diff",
        argumentHint: null,
      },
    ]);
  });

  it("filters runtime skill items by the current query", () => {
    expect(
      buildSlashComposerMenuItems({
        query: "rev",
        provider: "codex",
        runtimeSlashCommands: [
          {
            name: "review",
            description: "Review the diff",
          },
        ],
      }),
    ).toEqual([
      {
        id: "skill:runtime:review",
        type: "skill",
        name: "review",
        label: "/review",
        description: "Review the diff",
        argumentHint: null,
      },
    ]);
  });

  it("lets runtime skills override Claude project skills with the same name", () => {
    const items = buildSlashComposerMenuItems({
      query: "",
      provider: "claudeAgent",
      runtimeSlashCommands: [
        {
          name: "review",
          description: "Runtime review",
        },
      ],
      projectSkills: [
        createProjectSkill({
          description: "Project review",
        }),
      ],
    });

    expect(items.filter((item) => item.type === "skill")).toEqual([
      {
        id: "skill:runtime:review",
        type: "skill",
        name: "review",
        label: "/review",
        description: "Runtime review",
        argumentHint: null,
      },
    ]);
  });
});

describe("shouldRenderTimelineContent", () => {
  it("renders the timeline once details are loaded", () => {
    expect(
      shouldRenderTimelineContent({
        detailsLoaded: true,
        hasRenderableMessage: false,
      }),
    ).toBe(true);
  });

  it("renders the timeline while details are still loading when a chat message exists", () => {
    expect(
      shouldRenderTimelineContent({
        detailsLoaded: false,
        hasRenderableMessage: true,
      }),
    ).toBe(true);
  });

  it("keeps the loading placeholder while details are still loading without chat messages", () => {
    expect(
      shouldRenderTimelineContent({
        detailsLoaded: false,
        hasRenderableMessage: false,
      }),
    ).toBe(false);
  });
});

describe("buildComposerSkillReplacement", () => {
  it("inserts slash-form skill commands", () => {
    expect(buildComposerSkillReplacement("review")).toBe("/review ");
  });
});

describe("rewriteComposerRuntimeSkillInvocationForSend", () => {
  it("rewrites known Codex runtime skills from slash to dollar syntax", () => {
    expect(
      rewriteComposerRuntimeSkillInvocationForSend({
        text: "/review target",
        provider: "codex",
        runtimeSlashCommands: [
          {
            name: "review",
            description: "Review the diff",
          },
        ],
      }),
    ).toBe("$review target");
  });

  it("leaves unknown commands unchanged", () => {
    expect(
      rewriteComposerRuntimeSkillInvocationForSend({
        text: "/unknown target",
        provider: "codex",
        runtimeSlashCommands: [
          {
            name: "review",
            description: "Review the diff",
          },
        ],
      }),
    ).toBe("/unknown target");
  });

  it("ignores runtime skill names that are not host-compatible", () => {
    expect(
      rewriteComposerRuntimeSkillInvocationForSend({
        text: "/$review target",
        provider: "codex",
        runtimeSlashCommands: [
          {
            name: "$review",
            description: "Malformed runtime skill",
          },
        ],
      }),
    ).toBe("/$review target");
  });

  it("never rewrites host-local slash commands", () => {
    expect(
      rewriteComposerRuntimeSkillInvocationForSend({
        text: "/plan target",
        provider: "codex",
        runtimeSlashCommands: [
          {
            name: "plan",
            description: "Plan mode",
          },
        ],
      }),
    ).toBe("/plan target");
    expect(
      rewriteComposerRuntimeSkillInvocationForSend({
        text: "/default target",
        provider: "codex",
        runtimeSlashCommands: [
          {
            name: "default",
            description: "Default mode",
          },
        ],
      }),
    ).toBe("/default target");
    expect(
      rewriteComposerRuntimeSkillInvocationForSend({
        text: "/model gpt-5.4",
        provider: "codex",
        runtimeSlashCommands: [
          {
            name: "model",
            description: "Model switch",
          },
        ],
      }),
    ).toBe("/model gpt-5.4");
  });

  it("leaves non-Codex providers unchanged", () => {
    expect(
      rewriteComposerRuntimeSkillInvocationForSend({
        text: "/review target",
        provider: "claudeAgent",
        runtimeSlashCommands: [
          {
            name: "review",
            description: "Review the diff",
          },
        ],
      }),
    ).toBe("/review target");
  });

  it("only rewrites leading slash skills", () => {
    expect(
      rewriteComposerRuntimeSkillInvocationForSend({
        text: "please /review target",
        provider: "codex",
        runtimeSlashCommands: [
          {
            name: "review",
            description: "Review the diff",
          },
        ],
      }),
    ).toBe("please /review target");
  });
});

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
      filePathCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.makeUnsafe("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 0,
      filePathCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.makeUnsafe("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });

  it("treats attached file paths as sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "",
      imageCount: 0,
      filePathCount: 1,
      terminalContexts: [],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(0);
    expect(state.hasSendableContent).toBe(true);
  });
});

describe("readAttachedFileAbsolutePath", () => {
  it("prefers the desktop bridge path lookup when available", () => {
    const file = new File(["test"], "example.ts");

    expect(
      readAttachedFileAbsolutePath(file, {
        isElectron: true,
        desktopBridge: {
          getPathForFile: () => "/repo/project/apps/web/src/example.ts",
        },
      }),
    ).toBe("/repo/project/apps/web/src/example.ts");
  });

  it("falls back to Electron's legacy File.path when the bridge helper is unavailable", () => {
    const file = new File(["test"], "legacy.ts");
    Object.defineProperty(file, "path", {
      value: "/repo/project/apps/web/src/legacy.ts",
      configurable: true,
    });

    expect(
      readAttachedFileAbsolutePath(file, {
        isElectron: true,
      }),
    ).toBe("/repo/project/apps/web/src/legacy.ts");
  });

  it("returns undefined outside Electron when no bridge path is available", () => {
    const file = new File(["test"], "browser.ts");

    expect(
      readAttachedFileAbsolutePath(file, {
        isElectron: false,
      }),
    ).toBeUndefined();
  });
});

describe("resolveAttachedFileReferencePaths", () => {
  it("resolves workspace-relative attachment paths through the desktop bridge", () => {
    const file = new File(["test"], "example.ts");

    expect(
      resolveAttachedFileReferencePaths({
        files: [file],
        isElectron: true,
        desktopBridge: {
          getPathForFile: () => "/repo/project/src/example.ts",
        },
        workspaceRoots: ["/repo/project"],
        normalizeAbsolutePathForComparison: identityAbsolutePathNormalizer,
      }),
    ).toEqual({
      filePaths: ["src/example.ts"],
      missingPathCount: 0,
      invalidPathCount: 0,
    });
  });

  it("deduplicates resolved attachment paths while preserving order", () => {
    const files = [
      new File(["first"], "a.ts"),
      new File(["second"], "a-copy.ts"),
      new File(["third"], "outside.md"),
    ];
    const pathsByName = new Map([
      ["a.ts", "/repo/project/src/a.ts"],
      ["a-copy.ts", "/repo/project/src/a.ts"],
      ["outside.md", "/outside/workspace/outside.md"],
    ]);

    expect(
      resolveAttachedFileReferencePaths({
        files,
        isElectron: true,
        desktopBridge: {
          getPathForFile: (file) => pathsByName.get(file.name) ?? null,
        },
        workspaceRoots: ["/repo/project"],
        normalizeAbsolutePathForComparison: identityAbsolutePathNormalizer,
      }),
    ).toEqual({
      filePaths: ["src/a.ts", "/outside/workspace/outside.md"],
      missingPathCount: 0,
      invalidPathCount: 0,
    });
  });

  it("reports missing and invalid attachment paths separately", () => {
    const files = [new File(["missing"], "missing.ts"), new File(["invalid"], "invalid.ts")];

    expect(
      resolveAttachedFileReferencePaths({
        files,
        isElectron: true,
        desktopBridge: {
          getPathForFile: (file) => (file.name === "invalid.ts" ? "/repo/project/../.." : null),
        },
        workspaceRoots: ["/repo/project"],
        normalizeAbsolutePathForComparison: identityAbsolutePathNormalizer,
      }),
    ).toEqual({
      filePaths: [],
      missingPathCount: 1,
      invalidPathCount: 1,
    });
  });
});

describe("createCachedAbsolutePathComparisonNormalizer", () => {
  it("memoizes resolved path lookups per unique input", () => {
    const normalize = vi.fn((pathValue: string) => `${pathValue}:real`);
    const cachedNormalize = createCachedAbsolutePathComparisonNormalizer(normalize);

    expect(cachedNormalize("/repo/project")).toBe("/repo/project:real");
    expect(cachedNormalize("/repo/project")).toBe("/repo/project:real");
    expect(normalize).toHaveBeenCalledTimes(1);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats clear empty-state guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
  });

  it("formats omission guidance for sent messages", () => {
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("buildFirstSendBootstrap", () => {
  it("builds create-thread bootstrap for local drafts without worktree preparation", () => {
    expect(
      buildFirstSendBootstrap({
        isLocalDraftThread: true,
        projectId: ProjectId.makeUnsafe("project-1"),
        projectCwd: "/repo/project",
        projectModel: "gpt-5-codex",
        projectScripts: [],
        selectedModel: null,
        runtimeMode: "full-access",
        interactionMode: "plan",
        thread: {
          branch: "main",
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        baseBranchForWorktree: null,
      }),
    ).toEqual({
      createThread: {
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "New thread",
        model: "gpt-5-codex",
        runtimeMode: "full-access",
        interactionMode: "plan",
        branch: "main",
        worktreePath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
  });

  it("builds create-thread and worktree bootstrap for local worktree drafts", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("1234abcd-0000-0000-0000-000000000000");

    expect(
      buildFirstSendBootstrap({
        isLocalDraftThread: true,
        projectId: ProjectId.makeUnsafe("project-1"),
        projectCwd: "/repo/project",
        projectModel: "gpt-5-codex",
        projectScripts: [
          {
            id: "setup",
            name: "Setup",
            command: "bun install",
            icon: "configure",
            runOnWorktreeCreate: true,
          },
        ],
        selectedModel: "gpt-5.1-codex",
        runtimeMode: "approval-required",
        interactionMode: "default",
        thread: {
          branch: "main",
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        baseBranchForWorktree: "main",
      }),
    ).toEqual({
      createThread: {
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "New thread",
        model: "gpt-5.1-codex",
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: "main",
        worktreePath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      prepareWorktree: {
        projectCwd: "/repo/project",
        baseBranch: "main",
        branch: "t3code/1234abcd",
      },
      runSetupScript: true,
    });
  });

  it("builds worktree bootstrap for existing server threads", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("abcddcba-0000-0000-0000-000000000000");

    expect(
      buildFirstSendBootstrap({
        isLocalDraftThread: false,
        projectId: ProjectId.makeUnsafe("project-1"),
        projectCwd: "/repo/project",
        projectModel: "gpt-5-codex",
        projectScripts: [],
        selectedModel: "gpt-5.1-codex",
        runtimeMode: "full-access",
        interactionMode: "default",
        thread: {
          branch: "main",
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        baseBranchForWorktree: "main",
      }),
    ).toEqual({
      prepareWorktree: {
        projectCwd: "/repo/project",
        baseBranch: "main",
        branch: "t3code/abcddcba",
      },
    });
  });

  it("returns undefined when no first-send bootstrap is needed", () => {
    expect(
      buildFirstSendBootstrap({
        isLocalDraftThread: false,
        projectId: ProjectId.makeUnsafe("project-1"),
        projectCwd: "/repo/project",
        projectModel: "gpt-5-codex",
        projectScripts: [],
        selectedModel: null,
        runtimeMode: "full-access",
        interactionMode: "default",
        thread: {
          branch: "main",
          worktreePath: "/repo/project/.worktrees/thread-1",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        baseBranchForWorktree: null,
      }),
    ).toBeUndefined();
  });
});

describe("deriveProviderRuntimeInfoEntries", () => {
  it("builds the runtime banner entries from compact configured payloads", () => {
    expect(
      deriveProviderRuntimeInfoEntries({
        provider: "claudeAgent",
        threadModel: "claude-haiku-4-5",
        configuredRuntime: {
          model: "claude-haiku-4-5",
          claudeCodeVersion: "2.1.80",
          fastModeState: "off",
          effort: "max",
          outputStyle: "default",
          instructionContractVersion: "v2",
          instructionStrategy: "claude.append_system_prompt",
          sessionId: "session-123",
        },
        rerouteActivity: null,
        cliVersion: "1.2.3",
        mcpSummary: "2/3 connected",
      }),
    ).toEqual([
      { label: "Actual model", value: "claude-haiku-4-5" },
      { label: "Claude Code", value: "2.1.80" },
      { label: "Fast mode", value: "off" },
      { label: "Effort", value: "max" },
      { label: "Output", value: "default" },
      { label: "Contract", value: "v2" },
      { label: "Instructions", value: "claude.append_system_prompt" },
      { label: "Session", value: "session-123" },
      { label: "MCP", value: "2/3 connected" },
      { label: "CLI", value: "1.2.3" },
    ]);
  });
});
