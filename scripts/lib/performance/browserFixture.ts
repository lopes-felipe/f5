import { fixture, messageFixture } from "./fixtures.ts";

export const LARGE_THREAD = "perf-large";
export const SMALL_THREAD = "perf-small";
export const STREAM_THREADS = Array.from(
  { length: fixture.streaming.threads },
  (_, i) => `perf-stream-${i}`,
);
export const IMAGE_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9X8AAAAASUVORK5CYII=",
  "base64",
);

/** Wire fixtures shared unchanged by the pinned baseline and candidate builds. */
export function createBrowserFixture(protocolVersion = 1) {
  const time = fixture.epoch;
  const messages = (count: number, prefix = "perf-message") =>
    Array.from({ length: count }, (_, i) => {
      const data = messageFixture(i);
      return {
        id: `${prefix}-${i}`,
        role: data.role,
        text: data.text,
        turnId: null,
        streaming: false,
        createdAt: data.createdAt,
        updatedAt: data.createdAt,
        attachments: data.attachment
          ? [
              {
                type: "image",
                id: data.attachment,
                name: data.attachment,
                mimeType: "image/png",
                sizeBytes: IMAGE_BYTES.length,
              },
            ]
          : [],
      };
    });
  const thread = (id: string, title: string, count: number, prefix: string) => ({
    id,
    projectId: "perf-project",
    title,
    model: "gpt-5",
    interactionMode: "default",
    runtimeMode: "full-access",
    branch: "main",
    worktreePath: null,
    latestTurn: null,
    archivedAt: null,
    createdAt: time,
    lastInteractionAt: time,
    updatedAt: time,
    deletedAt: null,
    messages: messages(count, prefix),
    activities: [],
    proposedPlans: [],
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    compaction: null,
    checkpoints: [],
    session: {
      threadId: id,
      status: "ready",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: time,
    },
  });
  const threads = [
    thread(LARGE_THREAD, "Performance large thread", fixture.chat.messages, "perf-message"),
    thread(SMALL_THREAD, "Performance small thread", 20, "perf-small-message"),
    ...STREAM_THREADS.map((id) => thread(id, id, 2, `${id}-message`)),
  ];
  const commands = Array.from(
    { length: fixture.chat.messages / fixture.chat.toolEvery },
    (_, i) => {
      const index = i * fixture.chat.toolEvery;
      const createdAt = messageFixture(index).createdAt;
      return {
        id: `perf-command-${i}`,
        threadId: LARGE_THREAD,
        turnId: `perf-turn-${i}`,
        providerItemId: null,
        command: `cat output-${i}.txt`,
        title: null,
        status: "completed",
        detail: null,
        exitCode: 0,
        output: "x".repeat(fixture.chat.toolBytes),
        outputTruncated: false,
        startedAt: createdAt,
        completedAt: createdAt,
        updatedAt: createdAt,
        startedSequence: i + 1,
        lastUpdatedSequence: i + 1,
      };
    },
  );
  let sequence = 100;
  const snapshot = () => ({
    snapshotSequence: sequence,
    projects: [
      {
        id: "perf-project",
        title: "Performance fixture",
        workspaceRoot: "/fixture",
        defaultModel: "gpt-5",
        scripts: [],
        memories: [],
        createdAt: time,
        updatedAt: time,
        deletedAt: null,
      },
    ],
    threads: threads.map((t) => ({ ...t, messages: [] })),
    planningWorkflows: [],
    codeReviewWorkflows: [],
    investigationWorkflows: [],
    updatedAt: time,
  });
  const details = (id: string) => {
    const t = threads.find((t) => t.id === id);
    if (!t) throw new Error(`Unknown fixture thread ${id}`);
    return {
      threadId: id,
      messages: t.messages,
      checkpoints: [],
      activities: [],
      commandExecutions: id === LARGE_THREAD ? commands : [],
      tasks: [],
      tasksTurnId: null,
      tasksUpdatedAt: null,
      sessionNotes: null,
      threadReferences: [],
      hasOlderMessages: false,
      hasOlderCheckpoints: false,
      hasOlderCommandExecutions: false,
      oldestLoadedMessageCursor: {
        createdAt: t.messages[0]!.createdAt,
        messageId: t.messages[0]!.id,
      },
      oldestLoadedCheckpointTurnCount: null,
      oldestLoadedCommandExecutionCursor: null,
      detailSequence: sequence,
    };
  };
  const serverConfig = {
    cwd: "/fixture",
    keybindingsConfigPath: "/fixture/keybindings.json",
    keybindings: [],
    customKeybindings: [],
    issues: [],
    availableEditors: [],
    providers: [
      {
        instanceId: "codex",
        driver: "codex",
        displayName: "Codex",
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: time,
        models: [],
        slashCommands: [],
        skills: [],
      },
    ],
  };
  const unknownMethods = new Set<string>();
  return {
    threads,
    commands,
    unknownMethods,
    welcome: {
      cwd: "/fixture",
      projectName: "Performance fixture",
      bootstrapProjectId: "perf-project",
      bootstrapThreadId: SMALL_THREAD,
      bootstrap: {
        protocolVersion,
        capabilities: ["image-attachments"],
        uploadLimits: { attachments: { enabled: false, maxFileBytes: 0 } },
        sendLimits: {
          maxInputChars: 120000,
          maxImagesPerTurn: 8,
          maxImageBytes: 10485760,
          maxImageDataUrlChars: 14000000,
        },
      },
    },
    rpc(body: Record<string, unknown>): unknown {
      const id = typeof body.threadId === "string" ? body.threadId : SMALL_THREAD;
      switch (body._tag) {
        case "server.probe":
          return { ok: true };
        case "server.getConfig":
          return serverConfig;
        case "agents.getSnapshot":
          return { entries: [], generatedAt: time };
        case "nextTurnQueue.summary":
          return { threads: [] };
        case "nextTurnQueue.list":
          return {
            threadId: id,
            items: [],
            revision: 0,
            paused: false,
            blockedKind: null,
            reasonCode: null,
            reasonDetail: null,
            maxItems: 20,
            quarantinedCount: 0,
          };
        case "orchestration.getSnapshot":
          return snapshot();
        case "orchestration.getStartupSnapshot":
          return {
            snapshot: snapshot(),
            threadTailDetails:
              typeof body.detailThreadId === "string" ? details(body.detailThreadId) : null,
          };
        case "orchestration.getThreadTailDetails":
          return details(id);
        case "orchestration.getThreadDetails":
          return details(id);
        case "orchestration.getThreadCommandExecutions":
          return {
            threadId: id,
            executions: id === LARGE_THREAD ? commands : [],
            latestSequence: sequence,
            isFullSync: true,
          };
        case "orchestration.getThreadCommandExecution":
          return {
            commandExecution: commands.find((c) => c.id === body.commandExecutionId) ?? null,
          };
        case "orchestration.getThreadFileChanges":
          return { threadId: id, fileChanges: [], latestSequence: sequence, isFullSync: true };
        case "prHub.getOverview":
          return {
            status: "ok",
            viewerLogin: null,
            host: "github.com",
            counts: { needs_you: 0 },
            coverage: [],
            revision: "0",
            lastPolledAt: null,
          };
        case "git.listBranches":
          return {
            isRepo: true,
            hasOriginRemote: true,
            branches: [{ name: "main", current: true, isDefault: true, worktreePath: null }],
          };
        case "git.status":
          return {
            branch: "main",
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
            hasUpstream: true,
            aheadCount: 0,
            behindCount: 0,
            pr: null,
          };
        case "projects.listEntries":
        case "projects.searchEntries":
          return { entries: [], truncated: false, totalEntries: 0 };
        default:
          unknownMethods.add(String(body._tag));
          return {};
      }
    },
    /** Replace a fixed-size streaming message, so input data is bounded for the soak. */
    nextEvents() {
      return STREAM_THREADS.map((id) => {
        const t = threads.find((t) => t.id === id)!;
        const current = t.messages[1]!;
        sequence++;
        const text = `Streaming frame ${String(sequence).padStart(9, "0")}\n\n\`\`\`ts\nconst value = ${sequence % 1000};\n\`\`\``;
        t.messages[1] = { ...current, text, streaming: true };
        return {
          sequence,
          eventId: `perf-event-${sequence}`,
          aggregateKind: "thread",
          aggregateId: id,
          occurredAt: time,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.message-sent",
          payload: {
            threadId: id,
            messageId: current.id,
            role: "assistant",
            text,
            turnId: null,
            streaming: true,
            createdAt: current.createdAt,
            updatedAt: time,
          },
        };
      });
    },
  };
}
