// Production CSS is part of the behavior under test because row height depends on it.
import "../index.css";

import {
  CommandId,
  EventId,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationFileChange,
  type OrchestrationGetThreadCommandExecutionResult,
  type OrchestrationGetThreadFileChangeResult,
  type OrchestrationGetThreadFileChangesResult,
  type OrchestrationCommandExecution,
  type OrchestrationEvent,
  type OrchestrationGetThreadCommandExecutionsResult,
  type MessageId,
  type OrchestrationReadModel,
  type ProjectId,
  type ServerConfig,
  ThreadId,
  TurnId,
  type WsWelcomePayload,
  WS_CHANNELS,
  WS_METHODS,
  OrchestrationSessionStatus,
} from "@t3tools/contracts";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import { page } from "vitest/browser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { type ComposerImageAttachment, useComposerDraftStore } from "../composerDraftStore";
import {
  clearAllPendingTurnDispatchArtifacts,
  usePendingTurnDispatchStore,
} from "../pendingTurnDispatchStore";
import { parsePersistedAppSettings } from "../appSettings";
import { appendAttachedFilesToPrompt } from "../lib/attachedFiles";
import { resetLiveThreadWarmSchedulerForTests } from "../lib/threadPreload";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import { isMacPlatform } from "../lib/utils";
import { useModelPreferencesStore } from "../modelPreferencesStore";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { useRecoveryStateStore } from "../recoveryStateStore";
import { getRouter } from "../router";
import { useStore } from "../store";
import { createTestServerProvider } from "../testServerProvider";

const THREAD_ID = "thread-browser-test" as ThreadId;
const UUID_ROUTE_RE = /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_ID = "project-1" as ProjectId;
const NOW_ISO = "2026-03-04T12:00:00.000Z";
const BASE_TIME_MS = Date.parse(NOW_ISO);
const ATTACHMENT_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='300'></svg>";
const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";

interface WsRequestEnvelope {
  id: string;
  body: {
    _tag: string;
    [key: string]: unknown;
  };
}

interface TestWsClient {
  send: (data: string) => void;
  close: () => void;
}

type WsRequestResolution =
  | { type: "result"; result: unknown }
  | { type: "error"; message: string }
  | { type: "close" };

type MaybePromise<T> = T | Promise<T>;

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  threadCommandExecutionsByThreadId: Record<string, OrchestrationGetThreadCommandExecutionsResult>;
  threadFileChangesByThreadId: Record<string, OrchestrationGetThreadFileChangesResult>;
  threadFileChangeById: Record<string, Record<string, OrchestrationFileChange>>;
  welcome: WsWelcomePayload;
  resolveWsRequest?: (
    body: WsRequestEnvelope["body"],
    client: TestWsClient,
  ) => MaybePromise<WsRequestResolution | null | undefined>;
}

let fixture: TestFixture;
const wsRequests: WsRequestEnvelope["body"][] = [];
const wsLink = ws.link(/ws(s)?:\/\/.*/);

interface ViewportSpec {
  name: string;
  width: number;
  height: number;
}

const DEFAULT_VIEWPORT: ViewportSpec = {
  name: "desktop",
  width: 960,
  height: 1_100,
};

interface UserRowMeasurement {
  measuredRowHeightPx: number;
  timelineWidthMeasuredPx: number;
}

interface TimelineRowMeasurement extends UserRowMeasurement {
  rowBottomPx: number;
  rowTopPx: number;
  nextRowTopPx: number | null;
}

interface MountedChatView {
  cleanup: () => Promise<void>;
  measureUserRow: (targetMessageId: MessageId) => Promise<UserRowMeasurement>;
  measureTimelineRow: (options: {
    rowSelector: string;
    nextRowSelector?: string;
    // When true, don't scroll to the top before searching for the row. The
    // caller is responsible for ensuring the row is within the initial view
    // (e.g. placed near the end of the timeline so LegendList's
    // initialScrollAtEnd renders it). Useful to avoid flakes when the
    // scroll-up dance doesn't trigger re-virtualization reliably across test
    // runs.
    scrollToTop?: boolean;
  }) => Promise<TimelineRowMeasurement>;
  setViewport: (viewport: ViewportSpec) => Promise<void>;
  router: ReturnType<typeof getRouter>;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function isPromiseLike<T>(value: MaybePromise<T> | null | undefined): value is Promise<T> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function isoAt(offsetSeconds: number): string {
  return new Date(BASE_TIME_MS + offsetSeconds * 1_000).toISOString();
}

function createBaseServerConfig(): ServerConfig {
  return {
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/project/.t3code-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [createTestServerProvider("codex", { checkedAt: NOW_ISO })],
    availableEditors: [],
  };
}

function createModKeybinding(
  command: ServerConfig["keybindings"][number]["command"],
  key: string,
  options?: {
    shiftKey?: boolean;
    whenAst?: ServerConfig["keybindings"][number]["whenAst"];
  },
): ServerConfig["keybindings"][number] {
  return {
    command,
    shortcut: {
      key,
      metaKey: false,
      ctrlKey: false,
      shiftKey: options?.shiftKey ?? false,
      altKey: false,
      modKey: true,
    },
    ...(options?.whenAst ? { whenAst: options.whenAst } : {}),
  };
}

function createUserMessage(options: {
  id: MessageId;
  text: string;
  offsetSeconds: number;
  attachments?: Array<{
    type: "image";
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }>;
}) {
  return {
    id: options.id,
    role: "user" as const,
    text: options.text,
    ...(options.attachments ? { attachments: options.attachments } : {}),
    turnId: null,
    streaming: false,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

function createAssistantMessage(options: {
  id: MessageId;
  text: string;
  offsetSeconds: number;
  reasoningText?: string;
  streaming?: boolean;
}) {
  return {
    id: options.id,
    role: "assistant" as const,
    text: options.text,
    ...(options.reasoningText ? { reasoningText: options.reasoningText } : {}),
    turnId: null,
    streaming: options.streaming ?? false,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

function createCommandExecution(
  overrides: Partial<OrchestrationCommandExecution> = {},
): OrchestrationCommandExecution {
  return {
    id: "command-execution-1" as OrchestrationCommandExecution["id"],
    threadId: THREAD_ID,
    turnId: TurnId.makeUnsafe("turn-command-browser-test"),
    providerItemId: null,
    command: "/bin/zsh -lc 'echo hello'",
    title: null,
    status: "completed",
    detail: null,
    exitCode: 0,
    output: "hello",
    outputTruncated: false,
    startedAt: isoAt(10),
    completedAt: isoAt(11),
    updatedAt: isoAt(11),
    startedSequence: 1,
    lastUpdatedSequence: 2,
    ...overrides,
  };
}

function createThreadActivity(options: {
  id: string;
  createdAt: string;
  kind: string;
  summary: string;
  tone?: OrchestrationReadModel["threads"][number]["activities"][number]["tone"];
  payload?: Record<string, unknown>;
  turnId?: OrchestrationReadModel["threads"][number]["activities"][number]["turnId"];
  sequence?: number;
}): OrchestrationReadModel["threads"][number]["activities"][number] {
  return {
    id: options.id as OrchestrationReadModel["threads"][number]["activities"][number]["id"],
    createdAt: options.createdAt,
    kind: options.kind,
    summary: options.summary,
    tone: options.tone ?? "tool",
    payload: options.payload ?? {},
    turnId: options.turnId ?? null,
    ...(options.sequence !== undefined ? { sequence: options.sequence } : {}),
  };
}

function createTerminalContext(input: {
  id: string;
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
  text: string;
}): TerminalContextDraft {
  return {
    id: input.id,
    threadId: THREAD_ID,
    terminalId: `terminal-${input.id}`,
    terminalLabel: input.terminalLabel,
    lineStart: input.lineStart,
    lineEnd: input.lineEnd,
    text: input.text,
    createdAt: NOW_ISO,
  };
}

function createComposerImageAttachment(input: {
  id: string;
  name: string;
}): ComposerImageAttachment {
  const file = new File([ATTACHMENT_SVG], input.name, {
    type: "image/svg+xml",
  });

  return {
    type: "image",
    id: input.id,
    name: input.name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: URL.createObjectURL(file),
    file,
  };
}

function createSnapshotForTargetUser(options: {
  targetMessageId: MessageId;
  targetText: string;
  targetAttachmentCount?: number;
  tasks?: OrchestrationReadModel["threads"][number]["tasks"];
  sessionStatus?: OrchestrationSessionStatus;
  fillerPairCount?: number;
  targetPairIndex?: number;
}): OrchestrationReadModel {
  const messages: Array<OrchestrationReadModel["threads"][number]["messages"][number]> = [];
  const fillerPairCount = options.fillerPairCount ?? 22;
  const targetPairIndex = options.targetPairIndex ?? 3;

  for (let index = 0; index < fillerPairCount; index += 1) {
    const isTarget = index === targetPairIndex;
    const userId = `msg-user-${index}` as MessageId;
    const assistantId = `msg-assistant-${index}` as MessageId;
    const attachments =
      isTarget && (options.targetAttachmentCount ?? 0) > 0
        ? Array.from({ length: options.targetAttachmentCount ?? 0 }, (_, attachmentIndex) => ({
            type: "image" as const,
            id: `attachment-${attachmentIndex + 1}`,
            name: `attachment-${attachmentIndex + 1}.png`,
            mimeType: "image/png",
            sizeBytes: 128,
          }))
        : undefined;

    messages.push(
      createUserMessage({
        id: isTarget ? options.targetMessageId : userId,
        text: isTarget ? options.targetText : `filler user message ${index}`,
        offsetSeconds: messages.length * 3,
        ...(attachments ? { attachments } : {}),
      }),
    );
    messages.push(
      createAssistantMessage({
        id: assistantId,
        text: `assistant filler ${index}`,
        offsetSeconds: messages.length * 3,
      }),
    );
  }

  return {
    snapshotSequence: 1,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModel: "gpt-5",
        scripts: [],
        memories: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    planningWorkflows: [],
    codeReviewWorkflows: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Browser test thread",
        model: "gpt-5",
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        archivedAt: null,
        createdAt: NOW_ISO,
        lastInteractionAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        messages,
        activities: [],
        proposedPlans: [],
        tasks: options.tasks ?? [],
        tasksTurnId: null,
        tasksUpdatedAt: null,
        compaction: null,
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: options.sessionStatus ?? "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
    updatedAt: NOW_ISO,
  };
}

function buildFixture(snapshot: OrchestrationReadModel): TestFixture {
  return {
    snapshot,
    serverConfig: createBaseServerConfig(),
    threadCommandExecutionsByThreadId: {
      [THREAD_ID]: {
        threadId: THREAD_ID,
        executions: [],
        latestSequence: 0,
        isFullSync: true,
      },
    },
    threadFileChangesByThreadId: {
      [THREAD_ID]: {
        threadId: THREAD_ID,
        fileChanges: [],
        latestSequence: 0,
        isFullSync: true,
      },
    },
    threadFileChangeById: {
      [THREAD_ID]: {},
    },
    welcome: {
      cwd: "/repo/project",
      projectName: "Project",
      bootstrapProjectId: PROJECT_ID,
      bootstrapThreadId: THREAD_ID,
    },
  };
}

function addThreadToSnapshot(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationReadModel {
  return {
    ...snapshot,
    snapshotSequence: snapshot.snapshotSequence + 1,
    threads: [
      ...snapshot.threads,
      {
        id: threadId,
        projectId: PROJECT_ID,
        title: "New thread",
        model: "gpt-5",
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        archivedAt: null,
        createdAt: NOW_ISO,
        lastInteractionAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        messages: [],
        activities: [],
        proposedPlans: [],
        tasks: [],
        tasksTurnId: null,
        tasksUpdatedAt: null,
        compaction: null,
        checkpoints: [],
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
  };
}

function createDraftOnlySnapshot(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-draft-target" as MessageId,
    targetText: "draft thread",
  });
  return {
    ...snapshot,
    threads: [],
  };
}

function createSnapshotWithLongProposedPlan(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-plan-target" as MessageId,
    targetText: "plan thread",
  });
  const planMarkdown = [
    "# Ship plan mode follow-up",
    "",
    "- Step 1: capture the thread-open trace",
    "- Step 2: identify the main-thread bottleneck",
    "- Step 3: keep collapsed cards cheap",
    "- Step 4: render the full markdown only on demand",
    "- Step 5: preserve export and save actions",
    "- Step 6: add regression coverage",
    "- Step 7: verify route transitions stay responsive",
    "- Step 8: confirm no server-side work changed",
    "- Step 9: confirm short plans still render normally",
    "- Step 10: confirm long plans stay collapsed by default",
    "- Step 11: confirm preview text is still useful",
    "- Step 12: confirm plan follow-up flow still works",
    "- Step 13: confirm timeline virtualization still behaves",
    "- Step 14: confirm theme styling still looks correct",
    "- Step 15: confirm save dialog behavior is unchanged",
    "- Step 16: confirm download behavior is unchanged",
    "- Step 17: confirm code fences do not parse until expand",
    "- Step 18: confirm preview truncation ends cleanly",
    "- Step 19: confirm markdown links still open in editor after expand",
    "- Step 20: confirm deep hidden detail only appears after expand",
    "",
    "```ts",
    "export const hiddenPlanImplementationDetail = 'deep hidden detail only after expand';",
    "```",
  ].join("\n");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            proposedPlans: [
              {
                id: "plan-browser-test",
                turnId: null,
                planMarkdown,
                implementedAt: null,
                implementationThreadId: null,
                createdAt: isoAt(1_000),
                updatedAt: isoAt(1_001),
              },
            ],
            updatedAt: isoAt(1_001),
          })
        : thread,
    ),
  };
}

function createPlanFollowUpSnapshot(): OrchestrationReadModel {
  const snapshot = createSnapshotWithLongProposedPlan();
  return {
    ...snapshot,
    updatedAt: isoAt(1_010),
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            interactionMode: "plan" as const,
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-plan-follow-up"),
              state: "completed" as const,
              requestedAt: isoAt(1_000),
              startedAt: isoAt(1_001),
              completedAt: isoAt(1_002),
              assistantMessageId: null,
            },
            session: thread.session
              ? Object.assign({}, thread.session, {
                  status: "ready" as const,
                  activeTurnId: null,
                  updatedAt: isoAt(1_010),
                })
              : null,
            updatedAt: isoAt(1_010),
          })
        : thread,
    ),
  };
}

function createSnapshotWithCodexRuntimeSkills(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-codex-runtime-skills" as MessageId,
    targetText: "codex runtime skills target",
  });

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            activities: [
              ...thread.activities,
              createThreadActivity({
                id: "activity-runtime-configured-codex",
                createdAt: isoAt(24),
                kind: "runtime.configured",
                summary: "Codex runtime configured",
                payload: {
                  model: "gpt-5.4",
                  slashCommands: [
                    {
                      name: "review",
                      description: "Review the current diff",
                    },
                  ],
                },
              }),
            ],
          })
        : thread,
    ),
  };
}

function createSnapshotWithRichAssistantTarget(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-assistant-context" as MessageId,
    targetText: "rich assistant context",
  });
  const targetAssistantMessageId = "msg-assistant-rich-target" as MessageId;
  const targetTurnId =
    "turn-rich-assistant-target" as OrchestrationReadModel["threads"][number]["checkpoints"][number]["turnId"];
  const assistantMarkdown = [
    "## 9. UX Patterns Worth Porting (MEDIUM VALUE)",
    "",
    "### 9.1 Plan Mode",
    "",
    "A dedicated mode where the agent only reads and plans but does not make changes.",
    "",
    "- `EnterPlanModeTool` and `ExitPlanModeTool` drive the mode change",
    "- The mode should prevent writes while still allowing inspection",
    "- The user should be able to review the plan before execution",
    "",
    "---",
    "",
    "### 9.2 Brief Mode",
    "",
    "Controls output verbosity:",
    "",
    "- Brief mode keeps explanations minimal",
    "- Proactive mode allows autonomous follow-up work",
  ].join("\n");
  const reasoningMarkdown = [
    "The user wants a merged implementation plan.",
    "",
    "## Plan synthesis",
    "",
    "- Read each candidate plan",
    "- Identify overlaps",
    "- Keep only the highest-value parts",
  ].join("\n");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            messages: thread.messages.map((message) =>
              message.id === ("msg-assistant-3" as MessageId)
                ? createAssistantMessage({
                    id: targetAssistantMessageId,
                    text: assistantMarkdown,
                    reasoningText: reasoningMarkdown,
                    offsetSeconds: 21,
                  })
                : message,
            ),
            checkpoints: [
              {
                turnId: targetTurnId,
                checkpointTurnCount: 1,
                checkpointRef:
                  "checkpoint-rich-assistant-target" as OrchestrationReadModel["threads"][number]["checkpoints"][number]["checkpointRef"],
                status: "ready",
                files: [
                  {
                    path: "apps/web/src/components/chat/MessagesTimeline.tsx",
                    kind: "modified",
                    additions: 18,
                    deletions: 6,
                  },
                  {
                    path: "apps/web/src/components/timelineHeight.ts",
                    kind: "modified",
                    additions: 42,
                    deletions: 8,
                  },
                  {
                    path: "apps/web/src/index.css",
                    kind: "modified",
                    additions: 14,
                    deletions: 0,
                  },
                ],
                assistantMessageId: targetAssistantMessageId,
                completedAt: isoAt(22),
              },
            ],
          })
        : thread,
    ),
  };
}

function createSnapshotWithNestedWorkGroupTarget(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-work-context" as MessageId,
    targetText: "work group context",
  });

  // Place the work-group activities near the END of the timeline so
  // LegendList's `initialScrollAtEnd` renders them in the first paint. The
  // alternative (placing them at index ~7 and scrolling up) was flaky across
  // test runs because LegendList sometimes ignores direct `scrollTop` writes
  // after a previous instance was unmounted in the same session.
  // Timeline entries after this override, in order:
  //   …fillers…, asst-20 (isoAt 123), activity-subagent-target (isoAt 124),
  //   activity-file-change-support (isoAt 125), user-21 (isoAt 126),
  //   asst-21 (isoAt 129).
  // The test asserts that the (rich) activity-subagent-target row sits fully
  // above msg-user-21, which is the "next row" after skipping the sibling
  // activity rendered inside the same nested work-group.
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            activities: [
              createThreadActivity({
                id: "activity-subagent-target",
                createdAt: isoAt(124),
                kind: "tool.completed",
                summary: "Subagent task",
                payload: {
                  itemType: "collab_agent_tool_call",
                  subagentType: "Explore",
                  subagentModel: "gpt-5-mini",
                  subagentPrompt: [
                    "## Explore the renderer",
                    "",
                    "- Inspect the assistant message row",
                    "- Confirm how virtualization reserves height",
                  ].join("\n"),
                  subagentResult: [
                    "### Findings",
                    "",
                    "- Rich markdown is taller than the estimate",
                    "- The next row can overlap before remeasurement",
                  ].join("\n"),
                },
                sequence: 1,
              }),
              createThreadActivity({
                id: "activity-file-change-support",
                createdAt: isoAt(125),
                kind: "tool.completed",
                summary: "File change",
                payload: {
                  itemType: "file_change",
                  changedFiles: [
                    "apps/web/src/components/chat/MessagesTimeline.tsx",
                    "apps/web/src/components/ChatView.browser.tsx",
                  ],
                  detail: "Updated virtualization regression coverage",
                },
                sequence: 2,
              }),
            ],
          })
        : thread,
    ),
  };
}

function createSnapshotWithHistoricalFileChange(options?: {
  includeLaterUserMessage?: boolean;
  activityChangedFiles?: readonly string[];
}): OrchestrationReadModel {
  const base = createSnapshotForTargetUser({
    targetMessageId: "msg-user-historical-file-change" as MessageId,
    targetText: "historical file change target",
    fillerPairCount: 22,
    targetPairIndex: 19,
  });
  const historicalTurnId = TurnId.makeUnsafe("turn-historical-file-change");
  const nextTurnId = TurnId.makeUnsafe("turn-after-historical-file-change");
  const includeLaterUserMessage = options?.includeLaterUserMessage ?? false;
  const activityChangedFiles = options?.activityChangedFiles ?? ["/repo/project/REMOTE.md"];
  const updatedAt = includeLaterUserMessage ? isoAt(139) : isoAt(121);

  return {
    ...base,
    snapshotSequence: includeLaterUserMessage ? 2 : 1,
    updatedAt,
    threads: base.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            messages: [
              ...thread.messages,
              {
                ...createUserMessage({
                  id: "msg-user-edit-file" as MessageId,
                  text: "no, let me show you. edit a file",
                  offsetSeconds: 90,
                }),
                turnId: historicalTurnId,
              },
              {
                ...createAssistantMessage({
                  id: "msg-assistant-switch-file" as MessageId,
                  text: "I’m switching back to a simple sample file change.",
                  offsetSeconds: 97,
                }),
                turnId: historicalTurnId,
              },
              {
                ...createAssistantMessage({
                  id: "msg-assistant-remote-file" as MessageId,
                  text: "`REMOTE.md` is clean. I’m adding a single obvious test-only line near the top.",
                  offsetSeconds: 104,
                }),
                turnId: historicalTurnId,
              },
              {
                ...createAssistantMessage({
                  id: "msg-assistant-check-file" as MessageId,
                  text: "The edit is in place. I’m checking the diff to confirm it’s only that one-line addition.",
                  offsetSeconds: 112,
                }),
                turnId: historicalTurnId,
              },
              {
                ...createAssistantMessage({
                  id: "msg-assistant-file-summary" as MessageId,
                  text: "Added a minimal sample file change in REMOTE.md by inserting Sample inline diff change.",
                  offsetSeconds: 121,
                }),
                turnId: historicalTurnId,
              },
              ...(includeLaterUserMessage
                ? ([
                    {
                      ...createUserMessage({
                        id: "msg-user-after-file-change" as MessageId,
                        text: "ok, another one now",
                        offsetSeconds: 139,
                      }),
                      turnId: nextTurnId,
                    },
                  ] satisfies OrchestrationReadModel["threads"][number]["messages"])
                : []),
            ],
            activities: [
              createThreadActivity({
                id: "activity-remote-file-change",
                createdAt: isoAt(108),
                turnId: historicalTurnId,
                kind: "tool.completed",
                summary: "File change",
                payload: {
                  itemType: "file_change",
                  status: "completed",
                  changedFiles: [...activityChangedFiles],
                },
              }),
            ],
            checkpoints: [
              ...thread.checkpoints,
              {
                turnId: historicalTurnId,
                checkpointTurnCount: 2,
                checkpointRef:
                  "checkpoint-historical-file-change" as OrchestrationReadModel["threads"][number]["checkpoints"][number]["checkpointRef"],
                status: "ready",
                files: [
                  {
                    path: "REMOTE.md",
                    kind: "modified",
                    additions: 2,
                    deletions: 0,
                  },
                ],
                assistantMessageId: "msg-assistant-file-summary" as MessageId,
                completedAt: isoAt(121),
              },
            ],
            latestTurn: includeLaterUserMessage
              ? {
                  turnId: nextTurnId,
                  state: "running" as const,
                  requestedAt: isoAt(139),
                  startedAt: isoAt(139),
                  completedAt: null,
                  assistantMessageId: null,
                }
              : {
                  turnId: historicalTurnId,
                  state: "completed" as const,
                  requestedAt: isoAt(90),
                  startedAt: isoAt(97),
                  completedAt: isoAt(121),
                  assistantMessageId: "msg-assistant-file-summary" as MessageId,
                },
            session: thread.session
              ? Object.assign({}, thread.session, {
                  status: includeLaterUserMessage ? ("running" as const) : ("ready" as const),
                  activeTurnId: includeLaterUserMessage ? nextTurnId : null,
                  updatedAt,
                })
              : null,
            lastInteractionAt: updatedAt,
            updatedAt,
          })
        : thread,
    ),
  };
}

function createSnapshotWithSettlingInlineFileChange(options?: {
  settled?: boolean;
}): OrchestrationReadModel {
  const base = createSnapshotForTargetUser({
    targetMessageId: "msg-user-inline-settling-target" as MessageId,
    targetText: "inline settling target",
  });
  const turnId = TurnId.makeUnsafe("turn-inline-settling");
  const settled = options?.settled ?? false;
  const updatedAt = settled ? isoAt(76) : isoAt(60);

  return {
    ...base,
    snapshotSequence: settled ? 2 : 1,
    updatedAt,
    threads: base.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            messages: [
              ...thread.messages,
              {
                ...createAssistantMessage({
                  id: "msg-assistant-inline-settling-start" as MessageId,
                  text: "I’m editing `.docs/ci.md` now with the same minimal one-line addition.",
                  offsetSeconds: 57,
                }),
                turnId,
              },
              ...(settled
                ? ([
                    {
                      ...createAssistantMessage({
                        id: "msg-assistant-inline-settling-check" as MessageId,
                        text: "The sample edit is in place. I’m checking the diff and the line number.",
                        offsetSeconds: 67,
                      }),
                      turnId,
                    },
                    {
                      ...createAssistantMessage({
                        id: "msg-assistant-inline-settling-summary" as MessageId,
                        text: "Added another minimal sample file change in .docs/ci.md by inserting Sample inline diff change.",
                        offsetSeconds: 73,
                      }),
                      turnId,
                    },
                  ] satisfies OrchestrationReadModel["threads"][number]["messages"])
                : []),
            ],
            activities: [
              createThreadActivity({
                id: "activity-inline-settling-file-change",
                createdAt: isoAt(60),
                turnId,
                kind: "tool.completed",
                summary: "File change",
                payload: {
                  itemType: "file_change",
                  status: "completed",
                  changedFiles: ["/repo/project/.docs/ci.md"],
                },
              }),
            ],
            checkpoints: [
              ...thread.checkpoints,
              {
                turnId,
                checkpointTurnCount: 2,
                checkpointRef:
                  "checkpoint-inline-settling" as OrchestrationReadModel["threads"][number]["checkpoints"][number]["checkpointRef"],
                status: "ready",
                files: [
                  {
                    path: ".docs/ci.md",
                    kind: "modified",
                    additions: 2,
                    deletions: 0,
                  },
                ],
                assistantMessageId: "msg-assistant-inline-settling-summary" as MessageId,
                completedAt: isoAt(60),
              },
            ],
            latestTurn: settled
              ? {
                  turnId,
                  state: "completed" as const,
                  requestedAt: isoAt(50),
                  startedAt: isoAt(57),
                  completedAt: isoAt(60),
                  assistantMessageId: "msg-assistant-inline-settling-summary" as MessageId,
                }
              : {
                  turnId,
                  state: "running" as const,
                  requestedAt: isoAt(50),
                  startedAt: isoAt(57),
                  completedAt: null,
                  assistantMessageId: null,
                },
            session: thread.session
              ? Object.assign({}, thread.session, {
                  status: settled ? ("ready" as const) : ("running" as const),
                  activeTurnId: settled ? null : turnId,
                  updatedAt,
                })
              : null,
            lastInteractionAt: updatedAt,
            updatedAt,
          })
        : thread,
    ),
  };
}

function persistAppSettings(value: Record<string, unknown>) {
  localStorage.setItem(
    APP_SETTINGS_STORAGE_KEY,
    JSON.stringify({
      ...parsePersistedAppSettings(null),
      ...value,
    }),
  );
}

function createThreadCommandExecutionsResult(
  threadId: ThreadId,
  executions: ReadonlyArray<OrchestrationCommandExecution>,
): OrchestrationGetThreadCommandExecutionsResult {
  return {
    threadId,
    executions: [...executions],
    latestSequence: executions.reduce(
      (highestSequence, execution) => Math.max(highestSequence, execution.lastUpdatedSequence),
      0,
    ),
    isFullSync: true,
  };
}

function createThreadFileChangesResult(
  threadId: ThreadId,
  fileChanges: ReadonlyArray<OrchestrationGetThreadFileChangesResult["fileChanges"][number]>,
): OrchestrationGetThreadFileChangesResult {
  return {
    threadId,
    fileChanges: [...fileChanges],
    latestSequence: fileChanges.reduce(
      (highestSequence, fileChange) => Math.max(highestSequence, fileChange.lastUpdatedSequence),
      0,
    ),
    isFullSync: true,
  };
}

function createThreadTailDetailsResult(threadId: ThreadId) {
  const thread = fixture.snapshot.threads.find((entry) => entry.id === threadId);
  const commandExecutions = fixture.threadCommandExecutionsByThreadId[threadId]?.executions ?? [];
  return {
    threadId,
    messages: thread?.messages ?? [],
    checkpoints: thread?.checkpoints ?? [],
    commandExecutions,
    tasks: thread?.tasks ?? [],
    tasksTurnId: thread?.tasksTurnId ?? null,
    tasksUpdatedAt: thread?.tasksUpdatedAt ?? null,
    sessionNotes: null,
    threadReferences: [],
    hasOlderMessages: false,
    hasOlderCheckpoints: false,
    hasOlderCommandExecutions: false,
    oldestLoadedMessageCursor:
      thread?.messages[0] === undefined
        ? null
        : {
            createdAt: thread.messages[0].createdAt,
            messageId: thread.messages[0].id,
          },
    oldestLoadedCheckpointTurnCount: thread?.checkpoints[0]?.checkpointTurnCount ?? null,
    oldestLoadedCommandExecutionCursor:
      commandExecutions[0] === undefined
        ? null
        : {
            startedAt: commandExecutions[0].startedAt,
            startedSequence: commandExecutions[0].startedSequence,
            commandExecutionId: commandExecutions[0].id,
          },
    detailSequence: fixture.snapshot.snapshotSequence,
  };
}

function resolveWsRpc(body: WsRequestEnvelope["body"]): unknown {
  const tag = body._tag;
  if (tag === ORCHESTRATION_WS_METHODS.getSnapshot) {
    return fixture.snapshot;
  }
  if (tag === ORCHESTRATION_WS_METHODS.getStartupSnapshot) {
    const detailThreadId =
      typeof body.detailThreadId === "string" ? (body.detailThreadId as ThreadId) : null;
    const threadTailDetails =
      detailThreadId && fixture.snapshot.threads.some((thread) => thread.id === detailThreadId)
        ? createThreadTailDetailsResult(detailThreadId)
        : null;
    return {
      snapshot: fixture.snapshot,
      threadTailDetails,
    };
  }
  if (tag === ORCHESTRATION_WS_METHODS.getThreadTailDetails) {
    const threadId = typeof body.threadId === "string" ? body.threadId : THREAD_ID;
    return createThreadTailDetailsResult(threadId as ThreadId);
  }
  if (tag === ORCHESTRATION_WS_METHODS.getThreadHistoryPage) {
    const threadId = typeof body.threadId === "string" ? body.threadId : THREAD_ID;
    return {
      threadId: threadId as ThreadId,
      messages: [],
      checkpoints: [],
      commandExecutions: [],
      hasOlderMessages: false,
      hasOlderCheckpoints: false,
      hasOlderCommandExecutions: false,
      oldestLoadedMessageCursor: null,
      oldestLoadedCheckpointTurnCount: null,
      oldestLoadedCommandExecutionCursor: null,
      detailSequence: fixture.snapshot.snapshotSequence,
    };
  }
  if (tag === ORCHESTRATION_WS_METHODS.getThreadCommandExecutions) {
    const threadId = typeof body.threadId === "string" ? body.threadId : THREAD_ID;
    return (
      fixture.threadCommandExecutionsByThreadId[threadId] ??
      createThreadCommandExecutionsResult(threadId as ThreadId, [])
    );
  }
  if (tag === ORCHESTRATION_WS_METHODS.getThreadCommandExecution) {
    const threadId = typeof body.threadId === "string" ? body.threadId : THREAD_ID;
    const commandExecutionId =
      typeof body.commandExecutionId === "string" ? body.commandExecutionId : "";
    const executions = fixture.threadCommandExecutionsByThreadId[threadId]?.executions ?? [];
    const commandExecution =
      (executions.find((execution) => execution.id === commandExecutionId) as
        | OrchestrationCommandExecution
        | undefined) ?? null;
    return {
      commandExecution,
    } satisfies OrchestrationGetThreadCommandExecutionResult;
  }
  if (tag === ORCHESTRATION_WS_METHODS.getThreadFileChanges) {
    const threadId = typeof body.threadId === "string" ? body.threadId : THREAD_ID;
    return (
      fixture.threadFileChangesByThreadId[threadId] ??
      createThreadFileChangesResult(threadId as ThreadId, [])
    );
  }
  if (tag === ORCHESTRATION_WS_METHODS.getThreadFileChange) {
    const threadId = typeof body.threadId === "string" ? body.threadId : THREAD_ID;
    const fileChangeId = typeof body.fileChangeId === "string" ? body.fileChangeId : "";
    return {
      fileChange: fixture.threadFileChangeById[threadId]?.[fileChangeId] ?? null,
    } satisfies OrchestrationGetThreadFileChangeResult;
  }
  if (tag === WS_METHODS.serverGetConfig) {
    return fixture.serverConfig;
  }
  if (tag === WS_METHODS.gitListBranches) {
    return {
      isRepo: true,
      hasOriginRemote: true,
      branches: [
        {
          name: "main",
          current: true,
          isDefault: true,
          worktreePath: null,
        },
      ],
    };
  }
  if (tag === WS_METHODS.gitStatus) {
    return {
      branch: "main",
      hasWorkingTreeChanges: false,
      workingTree: {
        files: [],
        insertions: 0,
        deletions: 0,
      },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };
  }
  if (tag === WS_METHODS.projectsSearchEntries) {
    return {
      entries: [],
      truncated: false,
    };
  }
  if (tag === WS_METHODS.terminalOpen) {
    return {
      threadId: typeof body.threadId === "string" ? body.threadId : THREAD_ID,
      terminalId: typeof body.terminalId === "string" ? body.terminalId : "default",
      cwd: typeof body.cwd === "string" ? body.cwd : "/repo/project",
      status: "running",
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: NOW_ISO,
    };
  }
  return {};
}

const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    client.send(
      JSON.stringify({
        type: "push",
        sequence: 1,
        channel: WS_CHANNELS.serverWelcome,
        data: fixture.welcome,
      }),
    );
    client.addEventListener("message", (event) => {
      const rawData = event.data;
      if (typeof rawData !== "string") return;
      let request: WsRequestEnvelope;
      try {
        request = JSON.parse(rawData) as WsRequestEnvelope;
      } catch {
        return;
      }
      const method = request.body?._tag;
      if (typeof method !== "string") return;
      wsRequests.push(request.body);

      const sendError = (error: unknown) => {
        client.send(
          JSON.stringify({
            id: request.id,
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        );
      };

      const sendResolution = (resolution: WsRequestResolution | null | undefined) => {
        if (resolution?.type === "close") {
          client.close();
          return;
        }
        if (resolution?.type === "error") {
          client.send(
            JSON.stringify({
              id: request.id,
              error: {
                message: resolution.message,
              },
            }),
          );
          return;
        }
        client.send(
          JSON.stringify({
            id: request.id,
            result: resolution?.type === "result" ? resolution.result : resolveWsRpc(request.body),
          }),
        );
      };

      let resolution: MaybePromise<WsRequestResolution | null | undefined>;
      try {
        resolution = fixture.resolveWsRequest?.(request.body, client);
      } catch (error) {
        sendError(error);
        return;
      }

      if (isPromiseLike(resolution)) {
        void resolution.then(sendResolution).catch(sendError);
        return;
      }

      sendResolution(resolution);
    });
  }),
  http.get("*/attachments/:attachmentId", () =>
    HttpResponse.text(ATTACHMENT_SVG, {
      headers: {
        "Content-Type": "image/svg+xml",
      },
    }),
  ),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function waitForLayout(): Promise<void> {
  await nextFrame();
  await nextFrame();
  await nextFrame();
}

async function setViewport(viewport: ViewportSpec): Promise<void> {
  await page.viewport(viewport.width, viewport.height);
  await waitForLayout();
}

async function waitForProductionStyles(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
      ).not.toBe("");
      expect(getComputedStyle(document.body).marginTop).toBe("0px");
    },
    {
      timeout: 4_000,
      interval: 16,
    },
  );
}

async function waitForElement<T extends Element>(
  query: () => T | null,
  errorMessage: string,
): Promise<T> {
  let element: T | null = null;
  await vi.waitFor(
    () => {
      element = query();
      expect(element, errorMessage).toBeTruthy();
    },
    {
      timeout: 8_000,
      interval: 16,
    },
  );
  if (!element) {
    throw new Error(errorMessage);
  }
  return element;
}

async function waitForURL(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  let pathname = "";
  await vi.waitFor(
    () => {
      pathname = router.state.location.pathname;
      expect(predicate(pathname), errorMessage).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
  return pathname;
}

async function waitForComposerEditor(): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>('[contenteditable="true"]'),
    "Unable to find composer editor.",
  );
}

async function waitForComposerShell(): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>('[data-chat-composer-shell="true"]'),
    "Unable to find composer shell.",
  );
}

async function waitForSendButton(): Promise<HTMLButtonElement> {
  return waitForElement(
    () => document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
    "Unable to find send button.",
  );
}

function getDispatchCommandRequests(
  type?: string,
): Array<WsRequestEnvelope["body"] & { command?: unknown }> {
  return wsRequests.filter((request) => {
    if (request._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand) {
      return false;
    }
    if (!type) {
      return true;
    }
    return (request.command as { type?: unknown } | undefined)?.type === type;
  }) as Array<WsRequestEnvelope["body"] & { command?: unknown }>;
}

async function waitForButtonByText(text: string): Promise<HTMLButtonElement> {
  return waitForElement(
    () =>
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === text,
      ) as HTMLButtonElement | null,
    `Unable to find ${text} button.`,
  );
}

async function waitForButtonContainingText(text: string): Promise<HTMLButtonElement> {
  return waitForElement(
    () =>
      Array.from(document.querySelectorAll("button")).find((button) =>
        button.textContent?.includes(text),
      ) as HTMLButtonElement | null,
    `Unable to find button containing ${text}.`,
  );
}

async function waitForInteractionModeButton(
  expectedLabel: "Agent" | "Plan",
): Promise<HTMLButtonElement> {
  return waitForElement(
    () =>
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === expectedLabel,
      ) as HTMLButtonElement | null,
    `Unable to find ${expectedLabel} interaction mode button.`,
  );
}

async function waitForImagesToLoad(scope: ParentNode): Promise<void> {
  const images = Array.from(scope.querySelectorAll("img"));
  if (images.length === 0) {
    return;
  }
  await Promise.all(
    images.map(
      (image) =>
        new Promise<void>((resolve) => {
          if (image.complete) {
            resolve();
            return;
          }
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        }),
    ),
  );
  await waitForLayout();
}

async function measureTimelineRow(options: {
  host: HTMLElement;
  rowSelector: string;
  nextRowSelector?: string;
  scrollToTop?: boolean;
}): Promise<TimelineRowMeasurement> {
  const { host, nextRowSelector, rowSelector, scrollToTop = true } = options;

  // LegendList renders the scroll container inline with overflow:auto. Find
  // the nearest scrollable ancestor of any timeline-root element. We
  // intentionally require `[data-timeline-root]` to be present: the thread
  // route briefly renders a loading skeleton while `getThreadTailDetails` resolves,
  // and that skeleton uses an `overscroll-y-contain` container too. Matching it
  // before the timeline mounts would race the skeleton-to-timeline swap and
  // make us search for message rows in an empty container until the timeout.
  const scrollContainer = await waitForElement(() => {
    const anyTimelineRoot = host.querySelector<HTMLElement>('[data-timeline-root="true"]');
    if (!anyTimelineRoot) {
      return null;
    }
    let node: HTMLElement | null = anyTimelineRoot.parentElement;
    while (node) {
      const { overflowY, overflow } = window.getComputedStyle(node);
      if (overflowY === "auto" || overflowY === "scroll" || overflow === "auto") {
        return node;
      }
      node = node.parentElement;
    }
    return anyTimelineRoot.closest<HTMLElement>("div.overscroll-y-contain");
  }, "Unable to find ChatView message scroll container.");

  let row: HTMLElement | null = null;
  await vi.waitFor(
    async () => {
      if (scrollToTop) {
        // LegendList mounts with `initialScrollAtEnd`, which can ignore direct
        // scrollTop writes until it sees the element stretch past the viewport.
        // Using scrollTo with an animated behavior ensures the scroll is driven
        // through the browser's scroll mechanism so the list re-virtualizes.
        scrollContainer.scrollTo({ top: 0, behavior: "auto" });
        scrollContainer.scrollTop = 0;
        scrollContainer.dispatchEvent(new Event("scroll"));
      }
      await waitForLayout();
      row = host.querySelector<HTMLElement>(rowSelector);
      expect(row, "Unable to locate targeted user message row.").toBeTruthy();
    },
    {
      timeout: 8_000,
      interval: 16,
    },
  );

  await waitForImagesToLoad(row!);
  if (scrollToTop) {
    scrollContainer.scrollTop = 0;
    scrollContainer.dispatchEvent(new Event("scroll"));
  }
  await nextFrame();

  const timelineRoot =
    row!.closest<HTMLElement>('[data-timeline-root="true"]') ??
    host.querySelector<HTMLElement>('[data-timeline-root="true"]');
  if (!(timelineRoot instanceof HTMLElement)) {
    throw new Error("Unable to locate timeline root container.");
  }

  let timelineWidthMeasuredPx = 0;
  let measuredRowHeightPx = 0;
  let rowBottomPx = 0;
  let rowTopPx = 0;
  let nextRowTopPx: number | null = null;
  await vi.waitFor(
    async () => {
      if (scrollToTop) {
        scrollContainer.scrollTop = 0;
        scrollContainer.dispatchEvent(new Event("scroll"));
      }
      await nextFrame();
      const measuredRow = host.querySelector<HTMLElement>(rowSelector);
      expect(measuredRow, "Unable to measure targeted user row height.").toBeTruthy();
      timelineWidthMeasuredPx = timelineRoot.getBoundingClientRect().width;
      measuredRowHeightPx = measuredRow!.getBoundingClientRect().height;
      rowTopPx = measuredRow!.getBoundingClientRect().top;
      rowBottomPx = measuredRow!.getBoundingClientRect().bottom;
      if (nextRowSelector) {
        const nextRow = host.querySelector<HTMLElement>(nextRowSelector);
        expect(nextRow, "Unable to measure the row following the target row.").toBeTruthy();
        nextRowTopPx = nextRow!.getBoundingClientRect().top;
      }
      expect(timelineWidthMeasuredPx, "Unable to measure timeline width.").toBeGreaterThan(0);
      expect(measuredRowHeightPx, "Unable to measure targeted user row height.").toBeGreaterThan(0);
    },
    {
      timeout: 4_000,
      interval: 16,
    },
  );

  return {
    measuredRowHeightPx,
    timelineWidthMeasuredPx,
    rowBottomPx,
    rowTopPx,
    nextRowTopPx,
  };
}

async function measureUserRow(options: {
  host: HTMLElement;
  targetMessageId: MessageId;
}): Promise<UserRowMeasurement> {
  const measurement = await measureTimelineRow({
    host: options.host,
    rowSelector: `[data-message-id="${options.targetMessageId}"][data-message-role="user"]`,
  });
  return {
    measuredRowHeightPx: measurement.measuredRowHeightPx,
    timelineWidthMeasuredPx: measurement.timelineWidthMeasuredPx,
  };
}

function isElementVisibleWithinContainer(element: HTMLElement, container: HTMLElement): boolean {
  const elementRect = element.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  return elementRect.bottom > containerRect.top && elementRect.top < containerRect.bottom;
}

async function waitForTimelineRowVisible(rowSelector: string, message: string): Promise<void> {
  await vi.waitFor(
    () => {
      const scrollContainer = document.querySelector<HTMLElement>(
        '[data-slot="messages-scroll-container"]',
      );
      const row = document.querySelector<HTMLElement>(rowSelector);
      expect(scrollContainer, "Messages scroll container must be present.").toBeTruthy();
      expect(row, "Target timeline row must be rendered.").toBeTruthy();
      expect(isElementVisibleWithinContainer(row!, scrollContainer!), message).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function scrollTimelineRowIntoView(rowSelector: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const scrollContainer = document.querySelector<HTMLElement>(
        '[data-slot="messages-scroll-container"]',
      );
      const row = document.querySelector<HTMLElement>(rowSelector);
      expect(scrollContainer, "Messages scroll container must be present.").toBeTruthy();
      expect(row, "Target timeline row must be rendered.").toBeTruthy();
      row!.scrollIntoView({ block: "center" });
      scrollContainer!.dispatchEvent(new Event("scroll"));
      await waitForLayout();
      expect(isElementVisibleWithinContainer(row!, scrollContainer!)).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function mountChatView(options: {
  viewport: ViewportSpec;
  snapshot: OrchestrationReadModel;
  configureFixture?: (fixture: TestFixture) => void;
}): Promise<MountedChatView> {
  fixture = buildFixture(options.snapshot);
  options.configureFixture?.(fixture);
  await setViewport(options.viewport);
  await waitForProductionStyles();

  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.width = "100vw";
  host.style.height = "100vh";
  host.style.display = "grid";
  host.style.overflow = "hidden";
  document.body.append(host);

  const router = getRouter(
    createMemoryHistory({
      initialEntries: [`/${THREAD_ID}`],
    }),
  );

  const screen = await render(<RouterProvider router={router} />, {
    container: host,
  });

  await waitForLayout();

  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
    measureTimelineRow: async (options: {
      rowSelector: string;
      nextRowSelector?: string;
      scrollToTop?: boolean;
    }) => measureTimelineRow({ host, ...options }),
    measureUserRow: async (targetMessageId: MessageId) => measureUserRow({ host, targetMessageId }),
    setViewport: async (viewport: ViewportSpec) => {
      await setViewport(viewport);
      await waitForProductionStyles();
    },
    router,
  };
}

describe("ChatView timeline (full app)", () => {
  beforeAll(async () => {
    fixture = buildFixture(
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-bootstrap" as MessageId,
        targetText: "bootstrap",
      }),
    );
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: {
        url: "/mockServiceWorker.js",
      },
    });
  });

  afterAll(async () => {
    await worker.stop();
  });

  beforeEach(async () => {
    await setViewport(DEFAULT_VIEWPORT);
    localStorage.clear();
    document.body.innerHTML = "";
    wsRequests.length = 0;
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
    useModelPreferencesStore.setState({
      lastProvider: null,
      lastModelByProvider: {},
      lastModelOptions: null,
      lastWorkflowProviderBySlot: {},
    });
    useRecoveryStateStore.setState({
      recoveryEpoch: 0,
      lastCompletedAt: null,
    });
    usePendingTurnDispatchStore.setState({
      pendingByThreadId: {},
    });
    useCommandPaletteStore.setState({
      open: false,
      openIntent: null,
    });
    clearAllPendingTurnDispatchArtifacts();
    useStore.setState({
      projects: [],
      threads: [],
      planningWorkflows: [],
      codeReviewWorkflows: [],
      threadsHydrated: false,
      // Prevent cross-test leakage: a previous test's snapshot bumps
      // `lastAppliedSequence` and may leave buffered detail events on this
      // shared zustand store singleton, which can make the next test's fresh
      // snapshot look stale (skipping the details sync) and starve the route
      // of the data it needs to mount the timeline.
      lastAppliedSequence: 0,
      detailEventBufferByThreadId: new Map(),
      changedFilesExpandedByThreadId: {},
    });
    resetLiveThreadWarmSchedulerForTests();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders startup-bundled history without a follow-up thread-details RPC", async () => {
    const targetText = "startup bundled history";
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-startup-bundle" as MessageId,
        targetText,
        fillerPairCount: 2,
        targetPairIndex: 0,
      }),
    });

    try {
      await expect.element(page.getByText(targetText)).toBeInTheDocument();
      expect(
        wsRequests.some(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.getStartupSnapshot &&
            request.detailThreadId === THREAD_ID,
        ),
      ).toBe(true);
      expect(
        wsRequests.some(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.getThreadTailDetails &&
            request.threadId === THREAD_ID,
        ),
      ).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the loading skeleton visible until the first chat message arrives", async () => {
    const hiddenPlanTitle = "Hidden startup plan";
    const hiddenWorkSummary = "Hidden startup worklog";
    const firstMessageText = "first loaded chat message";
    const tailResponse = createDeferred<WsRequestResolution>();
    const startupSnapshot = (() => {
      const baseSnapshot = createSnapshotForTargetUser({
        targetMessageId: "msg-user-thread-load-placeholder" as MessageId,
        targetText: "placeholder",
        fillerPairCount: 0,
      });
      const thread = baseSnapshot.threads[0];
      if (!thread) {
        throw new Error("Expected the startup snapshot to include the active thread.");
      }
      return {
        ...baseSnapshot,
        threads: [
          Object.assign({}, thread, {
            proposedPlans: [
              {
                id: "plan-thread-load-placeholder",
                turnId: null,
                planMarkdown: `# ${hiddenPlanTitle}\n\nThis should stay hidden until the first message arrives.`,
                implementedAt: null,
                implementationThreadId: null,
                createdAt: isoAt(1),
                updatedAt: isoAt(2),
              },
            ],
            activities: [
              createThreadActivity({
                id: "activity-thread-load-placeholder",
                createdAt: isoAt(3),
                kind: "tool.completed",
                summary: hiddenWorkSummary,
                payload: {
                  itemType: "file_change",
                  changedFiles: ["apps/web/src/components/ChatView.tsx"],
                },
              }),
            ],
          }),
        ],
      };
    })();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: startupSnapshot,
      configureFixture: (nextFixture) => {
        nextFixture.resolveWsRequest = (body) => {
          if (body._tag === ORCHESTRATION_WS_METHODS.getStartupSnapshot) {
            return {
              type: "result",
              result: {
                snapshot: nextFixture.snapshot,
                threadTailDetails: null,
              },
            };
          }
          if (body._tag === ORCHESTRATION_WS_METHODS.getThreadTailDetails) {
            return tailResponse.promise;
          }
          return null;
        };
      },
    });

    try {
      await vi.waitFor(() => {
        expect(
          wsRequests.some(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.getThreadTailDetails &&
              request.threadId === THREAD_ID,
          ),
        ).toBe(true);

        const thread = useStore.getState().threads.find((entry) => entry.id === THREAD_ID);
        expect(thread?.detailsLoaded).toBe(false);
        expect(thread?.messages).toEqual([]);
        expect(thread?.proposedPlans).toHaveLength(1);
        expect(thread?.activities).toHaveLength(1);
      });

      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Loading thread details...");
      });
      expect(document.body.textContent).not.toContain(hiddenPlanTitle);
      expect(document.body.textContent).not.toContain(hiddenWorkSummary);
      expect(document.body.textContent).not.toContain("Send a message to start the conversation.");

      fixture.snapshot = {
        ...fixture.snapshot,
        snapshotSequence: 2,
        threads: fixture.snapshot.threads.map((thread) =>
          thread.id !== THREAD_ID
            ? thread
            : {
                ...thread,
                messages: [
                  createAssistantMessage({
                    id: "msg-assistant-thread-load-placeholder" as MessageId,
                    text: firstMessageText,
                    offsetSeconds: 10,
                  }),
                ],
                lastInteractionAt: isoAt(10),
                updatedAt: isoAt(10),
              },
        ),
      };
      tailResponse.resolve({
        type: "result",
        result: createThreadTailDetailsResult(THREAD_ID),
      });

      await vi.waitFor(() => {
        expect(document.body.textContent).toContain(firstMessageText);
        expect(document.body.textContent).toContain(hiddenPlanTitle);
        expect(document.body.textContent).toContain(hiddenWorkSummary);
        expect(document.body.textContent).not.toContain("Loading thread details...");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  // Regression: rich assistant rows (reasoning + changed-files preview) used
  // to require a dedicated non-virtualized region because the virtualizer
  // mis-estimated their heights. LegendList measures rows itself, so we now
  // only assert that adjacent rows don't overlap.
  it("keeps rich assistant rows from overlapping the next row", async () => {
    persistAppSettings({ showReasoningExpanded: true });
    const snapshot = createSnapshotWithRichAssistantTarget();
    const targetMessageId = "msg-assistant-rich-target" as MessageId;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
    });

    try {
      const measurement = await mounted.measureTimelineRow({
        rowSelector: `[data-message-id="${targetMessageId}"][data-message-role="assistant"]`,
        nextRowSelector: '[data-message-id="msg-user-4"][data-message-role="user"]',
      });

      expect(measurement.measuredRowHeightPx).toBeGreaterThan(0);
      expect(
        measurement.nextRowTopPx,
        "Unable to measure the row after the rich assistant row.",
      ).not.toBeNull();
      expect(measurement.nextRowTopPx!).toBeGreaterThanOrEqual(measurement.rowBottomPx - 1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps nested work-group rows from overlapping the next row", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithNestedWorkGroupTarget(),
    });

    try {
      const measurement = await mounted.measureTimelineRow({
        rowSelector: '[data-timeline-row-id="activity-subagent-target"]',
        nextRowSelector: '[data-message-id="msg-user-21"][data-message-role="user"]',
        // The activities are placed near the end of the timeline so
        // initialScrollAtEnd renders them on first paint — no scroll-up dance
        // needed. That dance is the source of the cross-test flake this
        // targeted arrangement sidesteps.
        scrollToTop: false,
      });

      expect(
        measurement.nextRowTopPx,
        "Unable to measure the row after the work-group row.",
      ).not.toBeNull();
      expect(measurement.nextRowTopPx!).toBeGreaterThanOrEqual(measurement.rowBottomPx - 1);
      expect(measurement.measuredRowHeightPx).toBeGreaterThan(220);
    } finally {
      await mounted.cleanup();
    }
  });

  it("refreshes completed command transcripts when late output arrives through a domain event", async () => {
    persistAppSettings({
      showAgentCommandTranscripts: true,
      alwaysExpandAgentCommandTranscripts: true,
      showReasoningExpanded: true,
    });
    let connectedClient: TestWsClient | null = null;
    // Place the command row AFTER every filler message (createSnapshotForTargetUser
    // produces 22 user+assistant pairs with the last assistant at isoAt(129)) so
    // LegendList's initialScrollAtEnd keeps the row inside the rendered window.
    // Earlier timestamps put the row above the viewport, which virtualizes it out.
    const initialExecution = createCommandExecution({
      id: "command-late-output" as OrchestrationCommandExecution["id"],
      command: "/bin/zsh -lc 'pwd'",
      output: "",
      startedAt: isoAt(200),
      completedAt: isoAt(201),
      updatedAt: isoAt(201),
      startedSequence: 1,
      lastUpdatedSequence: 2,
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-late-output" as MessageId,
        targetText: "show command transcripts",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.threadCommandExecutionsByThreadId[THREAD_ID] =
          createThreadCommandExecutionsResult(THREAD_ID, [initialExecution]);
        nextFixture.resolveWsRequest = (_body, client) => {
          connectedClient = client;
          return null;
        };
      },
    });

    try {
      const row = await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            '[data-timeline-row-id="command-late-output"][data-timeline-row-kind="command"]',
          ),
        "Unable to find the command transcript row.",
      );
      await vi.waitFor(() => {
        expect(row.textContent).toContain("(no output)");
      });

      fixture.threadCommandExecutionsByThreadId[THREAD_ID] = createThreadCommandExecutionsResult(
        THREAD_ID,
        [
          createCommandExecution({
            ...initialExecution,
            output: "/repo/project\n",
            updatedAt: isoAt(202),
            lastUpdatedSequence: 3,
          }),
        ],
      );

      const domainEvent = {
        sequence: 3,
        eventId: EventId.makeUnsafe("event-command-late-output"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: isoAt(202),
        commandId: CommandId.makeUnsafe("cmd-command-late-output"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.command-execution-output-appended",
        payload: {
          threadId: THREAD_ID,
          commandExecutionId: initialExecution.id,
          chunk: "/repo/project\n",
          updatedAt: isoAt(202),
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.command-execution-output-appended" }>;

      await vi.waitFor(() => {
        expect(connectedClient).not.toBeNull();
      });
      if (connectedClient === null) {
        throw new Error("Expected the test WebSocket client to be connected.");
      }
      const activeClient: TestWsClient = connectedClient;
      activeClient.send(
        JSON.stringify({
          type: "push",
          sequence: 2,
          channel: ORCHESTRATION_WS_CHANNELS.domainEvent,
          data: domainEvent,
        }),
      );

      await vi.waitFor(() => {
        expect(row.textContent).toContain("/repo/project");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("warms an unloaded background thread when a live assistant event arrives after startup", async () => {
    const backgroundThreadIds = Array.from({ length: 10 }, (_, index) =>
      ThreadId.makeUnsafe(`thread-background-live-${index}`),
    );
    const targetThreadId = backgroundThreadIds.at(-1)!;
    let snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-background-live-target" as MessageId,
      targetText: "keep background threads current",
      fillerPairCount: 2,
      targetPairIndex: 0,
    });

    snapshot = backgroundThreadIds.reduce(
      (currentSnapshot, threadId) => addThreadToSnapshot(currentSnapshot, threadId),
      snapshot,
    );
    snapshot = {
      ...snapshot,
      snapshotSequence: 1,
      threads: snapshot.threads.map((thread, index) =>
        index === 0
          ? thread
          : {
              ...thread,
              title: `Background thread ${index}`,
              lastInteractionAt: isoAt(300 - index),
              updatedAt: isoAt(300 - index),
            },
      ),
    };

    let connectedClient: TestWsClient | null = null;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
      configureFixture: (nextFixture) => {
        nextFixture.resolveWsRequest = (_body, client) => {
          connectedClient = client;
          return null;
        };
      },
    });

    try {
      await vi.waitFor(() => {
        const thread = useStore.getState().threads.find((entry) => entry.id === targetThreadId);
        expect(thread).toBeTruthy();
        expect(thread?.detailsLoaded).toBe(false);
        expect(thread?.messages).toEqual([]);
      });

      expect(
        wsRequests.some(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.getThreadTailDetails &&
            request.threadId === targetThreadId,
        ),
      ).toBe(false);

      fixture.snapshot = {
        ...fixture.snapshot,
        snapshotSequence: 2,
        threads: fixture.snapshot.threads.map((thread) =>
          thread.id !== targetThreadId
            ? thread
            : {
                ...thread,
                messages: [
                  createAssistantMessage({
                    id: "msg-assistant-background-live" as MessageId,
                    text: "background live delta",
                    offsetSeconds: 240,
                    streaming: true,
                  }),
                ],
                lastInteractionAt: isoAt(240),
                updatedAt: isoAt(240),
              },
        ),
      };

      await vi.waitFor(() => {
        expect(connectedClient).not.toBeNull();
      });
      if (connectedClient === null) {
        throw new Error("Expected the test WebSocket client to be connected.");
      }
      const client = connectedClient as TestWsClient;

      client.send(
        JSON.stringify({
          type: "push",
          sequence: 2,
          channel: ORCHESTRATION_WS_CHANNELS.domainEvent,
          data: {
            sequence: 2,
            eventId: EventId.makeUnsafe("event-background-live-message"),
            aggregateKind: "thread",
            aggregateId: targetThreadId,
            occurredAt: isoAt(240),
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "thread.message-sent",
            payload: {
              threadId: targetThreadId,
              messageId: "msg-assistant-background-live" as MessageId,
              role: "assistant",
              text: "background live delta",
              reasoningText: undefined,
              attachments: undefined,
              turnId: TurnId.makeUnsafe("turn-background-live"),
              streaming: true,
              createdAt: isoAt(240),
              updatedAt: isoAt(241),
            },
          } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>,
        }),
      );

      await vi.waitFor(() => {
        expect(
          wsRequests.some(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.getThreadTailDetails &&
              request.threadId === targetThreadId,
          ),
        ).toBe(true);

        const thread = useStore.getState().threads.find((entry) => entry.id === targetThreadId);
        expect(thread?.detailsLoaded).toBe(true);
        expect(thread?.messages.map((message) => message.text)).toEqual(["background live delta"]);
        expect(thread?.messages[0]?.streaming).toBe(true);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the project cwd for draft threads without a worktree path", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode"],
        };
      },
    });

    try {
      const openButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Open",
          ) as HTMLButtonElement | null,
        "Unable to find Open button.",
      );
      openButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscode",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the project cwd with VS Code Insiders when it is the only available editor", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode-insiders"],
        };
      },
    });

    try {
      const openButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Open",
          ) as HTMLButtonElement | null,
        "Unable to find Open button.",
      );
      await vi.waitFor(() => {
        expect(openButton.disabled).toBe(false);
      });
      openButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscode-insiders",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters the open picker menu and opens VSCodium from the menu", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode-insiders", "vscodium"],
        };
      },
    });

    try {
      const menuButton = await waitForElement(
        () => document.querySelector('button[aria-label="Copy options"]'),
        "Unable to find Open picker button.",
      );
      (menuButton as HTMLButtonElement).click();

      await waitForElement(
        () =>
          Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find((item) =>
            item.textContent?.includes("VS Code Insiders"),
          ) ?? null,
        "Unable to find VS Code Insiders menu item.",
      );

      expect(
        Array.from(document.querySelectorAll('[data-slot="menu-item"]')).some((item) =>
          item.textContent?.includes("Zed"),
        ),
      ).toBe(false);

      const vscodiumItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find((item) =>
            item.textContent?.includes("VSCodium"),
          ) ?? null,
        "Unable to find VSCodium menu item.",
      );
      (vscodiumItem as HTMLElement).click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscodium",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to the first installed editor when the stored favorite is unavailable", async () => {
    localStorage.setItem("t3code:last-editor", JSON.stringify("vscodium"));
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode-insiders"],
        };
      },
    });

    try {
      const openButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Open",
          ) as HTMLButtonElement | null,
        "Unable to find Open button.",
      );
      await vi.waitFor(() => {
        expect(openButton.disabled).toBe(false);
      });
      openButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscode-insiders",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the project cwd with IntelliJ IDEA when it is the only available editor", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["idea"],
        };
      },
    });

    try {
      const openButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Open",
          ) as HTMLButtonElement | null,
        "Unable to find Open button.",
      );
      await vi.waitFor(() => {
        expect(openButton.disabled).toBe(false);
      });
      openButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "idea",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("dispatches a single bootstrap turn-start for a draft worktree first send", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          envMode: "worktree",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const baseSnapshot = createDraftOnlySnapshot();
    const snapshot = Object.assign({}, baseSnapshot, {
      projects: baseSnapshot.projects.map((project) =>
        project.id === PROJECT_ID
          ? Object.assign({}, project, {
              scripts: [
                {
                  id: "setup",
                  name: "Setup",
                  command: "bun install",
                  icon: "configure",
                  runOnWorktreeCreate: true,
                },
              ],
            })
          : project,
      ),
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "Ship it");

      const sendButton = await waitForSendButton();
      await vi.waitFor(
        () => {
          expect(sendButton.disabled).toBe(false);
        },
        { timeout: 8_000, interval: 16 },
      );
      sendButton.click();

      await vi.waitFor(
        () => {
          const dispatchRequests = wsRequests.filter(
            (request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand,
          );
          expect(dispatchRequests).toHaveLength(1);

          const dispatchCommand = dispatchRequests[0]?.command as
            | {
                type?: unknown;
                bootstrap?: {
                  createThread?: Record<string, unknown>;
                  prepareWorktree?: Record<string, unknown>;
                  runSetupScript?: unknown;
                };
              }
            | undefined;
          expect(dispatchCommand?.type).toBe("thread.turn.start");

          const bootstrap = dispatchCommand?.bootstrap;
          expect(bootstrap?.createThread).toMatchObject({
            projectId: PROJECT_ID,
            title: "New thread",
          });
          expect(bootstrap?.prepareWorktree).toMatchObject({
            projectCwd: "/repo/project",
            baseBranch: "main",
          });
          expect(bootstrap?.prepareWorktree?.branch).toMatch(/^t3code\/[0-9a-f]{8}$/);
          expect(bootstrap?.runSetupScript).toBe(true);

          expect(
            dispatchRequests.some((request) => {
              const command = request.command as { type?: unknown } | undefined;
              return command?.type === "thread.create" || command?.type === "thread.meta.update";
            }),
          ).toBe(false);
          expect(wsRequests.some((request) => request._tag === WS_METHODS.gitCreateWorktree)).toBe(
            false,
          );
          expect(wsRequests.some((request) => request._tag === WS_METHODS.terminalWrite)).toBe(
            false,
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders a collapsible task panel when the thread has tracked tasks", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-task-panel" as MessageId,
        targetText: "task panel target",
        tasks: [
          {
            id: "task-1",
            content: "Inspect the current implementation",
            activeForm: "Inspecting the current implementation",
            status: "completed",
          },
          {
            id: "task-2",
            content: "Implement the task panel",
            activeForm: "Implementing the task panel",
            status: "in_progress",
          },
          {
            id: "task-3",
            content: "Run bun typecheck",
            activeForm: "Running bun typecheck",
            status: "pending",
          },
        ],
      }),
    });

    try {
      const taskPanelButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find((button) =>
            button.textContent?.includes("Task list"),
          ) as HTMLButtonElement | null,
        "Unable to find the task panel toggle.",
      );

      expect(taskPanelButton.getAttribute("aria-expanded")).toBe("true");
      expect(taskPanelButton.textContent).toContain("1 active · 1 pending · 1 done");
      expect(document.body.textContent).toContain("Implementing the task panel");

      taskPanelButton.click();
      await waitForLayout();

      expect(taskPanelButton.getAttribute("aria-expanded")).toBe("false");

      const nextSnapshot = createSnapshotForTargetUser({
        targetMessageId: "msg-user-task-panel" as MessageId,
        targetText: "task panel target",
        tasks: [
          {
            id: "task-1",
            content: "Inspect the current implementation",
            activeForm: "Inspecting the current implementation",
            status: "completed",
          },
          {
            id: "task-2",
            content: "Implement the task panel",
            activeForm: "Implemented the task panel",
            status: "completed",
          },
          {
            id: "task-3",
            content: "Run bun typecheck",
            activeForm: "Running bun typecheck",
            status: "in_progress",
          },
        ],
      });
      fixture.snapshot = nextSnapshot;
      useStore.getState().syncServerReadModel(nextSnapshot);
      await waitForLayout();

      expect(taskPanelButton.getAttribute("aria-expanded")).toBe("false");
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles plan mode with Shift+Tab only while the composer is focused", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-target-hotkey" as MessageId,
        targetText: "hotkey target",
      }),
    });

    try {
      const initialModeButton = await waitForInteractionModeButton("Agent");
      const initialComposerShell = await waitForComposerShell();
      expect(initialModeButton.title).toContain("enter plan mode");
      expect(initialComposerShell.className).toContain("border-border");
      expect(initialComposerShell.className).toContain("focus-within:border-ring/45");
      expect(initialComposerShell.className).not.toContain("border-success/10");

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitForLayout();

      expect((await waitForInteractionModeButton("Agent")).title).toContain("enter plan mode");

      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(
        async () => {
          expect((await waitForInteractionModeButton("Plan")).title).toContain(
            "return to normal chat mode",
          );
          const composerShell = await waitForComposerShell();
          expect(composerShell.className).toContain("border-warning/10");
          expect(composerShell.className).toContain("focus-within:border-warning/45");
          expect(composerShell.className).not.toContain("border-purple-500/10");
        },
        { timeout: 8_000, interval: 16 },
      );

      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(
        async () => {
          expect((await waitForInteractionModeButton("Agent")).title).toContain("enter plan mode");
          const composerShell = await waitForComposerShell();
          expect(composerShell.className).toContain("border-border");
          expect(composerShell.className).toContain("focus-within:border-ring/45");
          expect(composerShell.className).not.toContain("border-warning/10");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps backspaced terminal context pills removed when a new one is added", async () => {
    const removedLabel = "Terminal 1 lines 1-2";
    const addedLabel = "Terminal 2 lines 9-10";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_ID,
      createTerminalContext({
        id: "ctx-removed",
        terminalLabel: "Terminal 1",
        lineStart: 1,
        lineEnd: 2,
        text: "bun i\nno changes",
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-terminal-pill-backspace" as MessageId,
        targetText: "terminal pill backspace target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Backspace",
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]).toBeUndefined();
          expect(document.body.textContent).not.toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      useComposerDraftStore.getState().addTerminalContext(
        THREAD_ID,
        createTerminalContext({
          id: "ctx-added",
          terminalLabel: "Terminal 2",
          lineStart: 9,
          lineEnd: 10,
          text: "git status\nOn branch main",
        }),
      );

      await vi.waitFor(
        () => {
          const draft = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID];
          expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-added"]);
          expect(document.body.textContent).toContain(addedLabel);
          expect(document.body.textContent).not.toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("disables send when the composer only contains an expired terminal pill", async () => {
    const expiredLabel = "Terminal 1 line 4";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_ID,
      createTerminalContext({
        id: "ctx-expired-only",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "",
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-expired-pill-disabled" as MessageId,
        targetText: "expired pill disabled target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(expiredLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(true);
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders composer file chips from draft state and removes them", async () => {
    const filePath = "/repo/project/apps/web/src/components/draft-file-attachment.tsx";
    useComposerDraftStore.getState().addFilePaths(THREAD_ID, [filePath]);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-file-chip-target" as MessageId,
        targetText: "file chip target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent ?? "").toContain("draft-file-attachment.tsx");
        },
        { timeout: 8_000, interval: 16 },
      );

      const removeButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find((button) =>
            button.getAttribute("aria-label")?.includes("draft-file-attachment.tsx"),
          ) as HTMLButtonElement | null,
        "Unable to find the draft file attachment remove button.",
      );
      await removeButton.click();

      await vi.waitFor(
        () => {
          expect(
            useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.filePaths ?? [],
          ).toEqual([]);
          expect(document.body.textContent ?? "").not.toContain("draft-file-attachment.tsx");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("sends file-only drafts with workspace-relative attachment paths and a filename title fallback", async () => {
    const absoluteFilePath = "/repo/project/apps/web/src/components/file-only-send.tsx";
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });
    useComposerDraftStore.getState().addFilePaths(THREAD_ID, [absoluteFilePath]);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      const sendButton = await waitForSendButton();
      await vi.waitFor(
        () => {
          expect(sendButton.disabled).toBe(false);
        },
        { timeout: 8_000, interval: 16 },
      );
      sendButton.click();

      await vi.waitFor(
        () => {
          const dispatchRequests = getDispatchCommandRequests("thread.turn.start");
          expect(dispatchRequests).toHaveLength(1);

          const dispatchCommand = dispatchRequests[0]?.command as
            | {
                message?: { text?: string };
                titleSourceText?: string;
              }
            | undefined;
          expect(dispatchCommand?.titleSourceText).toBe("file-only-send.tsx");
          expect(dispatchCommand?.message?.text).toBe(
            appendAttachedFilesToPrompt("", ["apps/web/src/components/file-only-send.tsx"]),
          );
          expect(dispatchCommand?.message?.text).not.toContain(absoluteFilePath);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps absolute attachment paths for file-only drafts outside the workspace", async () => {
    const absoluteFilePath = "/outside/repo/external-notes.md";
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });
    useComposerDraftStore.getState().addFilePaths(THREAD_ID, [absoluteFilePath]);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      const sendButton = await waitForSendButton();
      await vi.waitFor(
        () => {
          expect(sendButton.disabled).toBe(false);
        },
        { timeout: 8_000, interval: 16 },
      );
      sendButton.click();

      await vi.waitFor(
        () => {
          const dispatchRequests = getDispatchCommandRequests("thread.turn.start");
          expect(dispatchRequests).toHaveLength(1);

          const dispatchCommand = dispatchRequests[0]?.command as
            | {
                message?: { text?: string };
                titleSourceText?: string;
              }
            | undefined;
          expect(dispatchCommand?.titleSourceText).toBe("external-notes.md");
          expect(dispatchCommand?.message?.text).toBe(
            appendAttachedFilesToPrompt("", [absoluteFilePath]),
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("rewrites Codex runtime slash skills to dollar syntax when sending", async () => {
    const typedPrompt = "/review current diff";

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithCodexRuntimeSkills(),
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, typedPrompt);

      const sendButton = await waitForSendButton();
      await vi.waitFor(
        () => {
          expect(sendButton.disabled).toBe(false);
        },
        { timeout: 8_000, interval: 16 },
      );
      sendButton.click();

      await vi.waitFor(
        () => {
          const dispatchRequests = getDispatchCommandRequests("thread.turn.start");
          expect(dispatchRequests).toHaveLength(1);

          const dispatchCommand = dispatchRequests[0]?.command as
            | {
                message?: { text?: string };
                titleSourceText?: string;
              }
            | undefined;
          expect(dispatchCommand?.titleSourceText).toBe(typedPrompt);
          expect(dispatchCommand?.message?.text).toBe("$review current diff");
          expect(document.body.textContent).toContain("$review current diff");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("warns when sending text while omitting expired terminal pills", async () => {
    const expiredLabel = "Terminal 1 line 4";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_ID,
      createTerminalContext({
        id: "ctx-expired-send-warning",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "",
      }),
    );
    useComposerDraftStore
      .getState()
      .setPrompt(THREAD_ID, `yoo${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}waddup`);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-expired-pill-warning" as MessageId,
        targetText: "expired pill warning target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(expiredLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(
            "Expired terminal context omitted from message",
          );
          expect(document.body.textContent).not.toContain(expiredLabel);
          expect(document.body.textContent).toContain("yoowaddup");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a pointer cursor for the running stop button", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-stop-button-cursor" as MessageId,
        targetText: "stop button cursor target",
        sessionStatus: "running",
      }),
    });

    try {
      const stopButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
        "Unable to find stop generation button.",
      );

      expect(getComputedStyle(stopButton).cursor).toBe("pointer");
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the new thread selected after clicking the new-thread button", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-new-thread-test" as MessageId,
        targetText: "new thread selection test",
      }),
    });

    try {
      // Wait for the sidebar to render with the project.
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      // The route should change to a new draft thread ID.
      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      // The composer editor should be present for the new draft thread.
      await waitForComposerEditor();

      // Simulate the snapshot sync arriving from the server after the draft
      // thread has been promoted to a server thread (thread.create + turn.start
      // succeeded). The snapshot now includes the new thread, and the sync
      // should clear the draft without disrupting the route.
      const { syncServerReadModel } = useStore.getState();
      syncServerReadModel(addThreadToSnapshot(fixture.snapshot, newThreadId));

      // Clear the draft now that the server thread exists (mirrors EventRouter behavior).
      useComposerDraftStore.getState().clearDraftThread(newThreadId);

      // The route should still be on the new thread — not redirected away.
      await waitForURL(
        mounted.router,
        (path) => path === newThreadPath,
        "New thread should remain selected after snapshot sync clears the draft.",
      );

      // The empty thread view and composer should still be visible.
      await expect
        .element(page.getByText("Send a message to start the conversation."))
        .toBeInTheDocument();
      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a new thread from the global chat.new shortcut", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-chat-shortcut-test" as MessageId,
        targetText: "chat shortcut test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            createModKeybinding("chat.new", "n", {
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            }),
          ],
        };
      },
    });

    try {
      const useMetaForMod = isMacPlatform(navigator.platform);
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "n",
          metaKey: useMetaForMod,
          ctrlKey: !useMetaForMod,
          bubbles: true,
          cancelable: true,
        }),
      );

      await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID from the shortcut.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a fresh draft after the previous draft thread is promoted", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-promoted-draft-shortcut-test" as MessageId,
        targetText: "promoted draft shortcut test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            createModKeybinding("chat.new", "n", {
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            }),
          ],
        };
      },
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();
      await newThreadButton.click();

      const promotedThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a promoted draft thread UUID.",
      );
      const promotedThreadId = promotedThreadPath.slice(1) as ThreadId;

      const { syncServerReadModel } = useStore.getState();
      syncServerReadModel(addThreadToSnapshot(fixture.snapshot, promotedThreadId));
      useComposerDraftStore.getState().clearDraftThread(promotedThreadId);

      const useMetaForMod = isMacPlatform(navigator.platform);
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "n",
          metaKey: useMetaForMod,
          ctrlKey: !useMetaForMod,
          bubbles: true,
          cancelable: true,
        }),
      );

      const freshThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path) && path !== promotedThreadPath,
        "Shortcut should create a fresh draft instead of reusing the promoted thread.",
      );
      expect(freshThreadPath).not.toBe(promotedThreadPath);
    } finally {
      await mounted.cleanup();
    }
  });

  it("scrolls to the bottom from cmd+enter without sending when the pill is visible", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-scroll-shortcut" as MessageId,
        targetText: "scroll shortcut target",
        fillerPairCount: 40,
        targetPairIndex: 34,
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [createModKeybinding("chat.scrollToBottom", "enter")],
        };
      },
    });

    try {
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-slot="messages-scroll-container"]'),
        "Messages scroll container should render before testing scroll shortcuts.",
      );
      scrollContainer.scrollTo({ top: 0, behavior: "auto" });
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));

      const useMetaForMod = isMacPlatform(navigator.platform);
      const scrollButton = await waitForButtonContainingText("Scroll to bottom");
      expect(scrollButton.textContent).toContain(useMetaForMod ? "⌘Enter" : "Ctrl+Enter");

      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: useMetaForMod,
          ctrlKey: !useMetaForMod,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(
        () => {
          expect(document.body.textContent).not.toContain("Scroll to bottom");
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(getDispatchCommandRequests("thread.turn.start")).toHaveLength(0);
    } finally {
      await mounted.cleanup();
    }
  });

  it("never sends from cmd+enter while the composer is focused and the pill is hidden", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-scroll-no-send" as MessageId,
        targetText: "scroll shortcut no-send target",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [createModKeybinding("chat.scrollToBottom", "enter")],
        };
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "Do not send this");

      const sendButton = await waitForSendButton();
      await vi.waitFor(
        () => {
          expect(sendButton.disabled).toBe(false);
        },
        { timeout: 8_000, interval: 16 },
      );

      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      const useMetaForMod = isMacPlatform(navigator.platform);
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: useMetaForMod,
          ctrlKey: !useMetaForMod,
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitForLayout();

      expect(document.body.textContent).not.toContain("Scroll to bottom");
      expect(getDispatchCommandRequests("thread.turn.start")).toHaveLength(0);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the command palette modified-Enter add-project path working while the pill is hidden", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-palette-scroll-shortcut" as MessageId,
        targetText: "command palette scroll shortcut target",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [createModKeybinding("chat.scrollToBottom", "enter")],
        };
        nextFixture.resolveWsRequest = (body) => {
          if (body._tag !== WS_METHODS.filesystemBrowse) {
            return null;
          }
          return {
            type: "result",
            result: {
              parentPath: "~/",
              entries: [
                {
                  name: "project-two",
                  fullPath: "~/project-two",
                },
              ],
            },
          };
        };
      },
    });

    try {
      useCommandPaletteStore.getState().openAddProject();

      const paletteInput = await waitForElement(
        () => document.querySelector<HTMLInputElement>('[data-testid="command-palette"] input'),
        "Command palette input should render for the add-project flow.",
      );
      paletteInput.focus();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("project-two");
        },
        { timeout: 8_000, interval: 16 },
      );

      paletteInput.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      );

      const useMetaForMod = isMacPlatform(navigator.platform);
      await vi.waitFor(
        () => {
          const addButton = document.querySelector<HTMLButtonElement>(
            '[data-testid="command-palette"] button[aria-label^="Add ("]',
          );
          expect(addButton?.getAttribute("aria-label")).toContain(
            useMetaForMod ? "⌘ Enter" : "Ctrl Enter",
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      paletteInput.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: useMetaForMod,
          ctrlKey: !useMetaForMod,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(
        () => {
          expect(getDispatchCommandRequests("project.create")).toHaveLength(1);
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(getDispatchCommandRequests("thread.turn.start")).toHaveLength(0);
    } finally {
      await mounted.cleanup();
    }
  });

  it("recovers a draft first send after reconnect when snapshot proves acceptance", async () => {
    const sentText = "Recover this first send";
    let dispatchedMessageId: MessageId | null = null;

    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.resolveWsRequest = (body, _client) => {
          if (body._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand) {
            return null;
          }
          const command = body.command as
            | {
                type?: unknown;
                message?: { messageId?: MessageId; text?: string };
              }
            | undefined;
          if (command?.type !== "thread.turn.start") {
            return null;
          }

          dispatchedMessageId = command.message?.messageId ?? null;
          nextFixture.snapshot = createSnapshotForTargetUser({
            targetMessageId: dispatchedMessageId ?? ("msg-user-recovered" as MessageId),
            targetText: sentText,
          });
          return { type: "close" };
        };
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, sentText);

      const sendButton = await waitForSendButton();
      await vi.waitFor(
        () => {
          expect(sendButton.disabled).toBe(false);
        },
        { timeout: 8_000, interval: 16 },
      );
      sendButton.click();

      await vi.waitFor(
        () => {
          expect(dispatchedMessageId).not.toBeNull();
          expect(useRecoveryStateStore.getState().recoveryEpoch).toBeGreaterThan(0);
          const recoveredThread = useStore
            .getState()
            .threads.find((thread) => thread.id === THREAD_ID);
          expect(
            recoveredThread?.messages.some((message) => message.id === dispatchedMessageId),
          ).toBe(true);
          expect(document.body.textContent).not.toContain("Retry send");
        },
        { timeout: 12_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows recovery actions after reconnect, retries with the original command id, and avoids duplicate optimistic rows", async () => {
    const sentText = "Retry this pending send";
    let firstCommandId: string | null = null;
    let firstMessageId: MessageId | null = null;

    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.resolveWsRequest = (body) => {
          if (body._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand) {
            return null;
          }
          const command = body.command as
            | {
                type?: unknown;
                commandId?: string;
                message?: { messageId?: MessageId };
              }
            | undefined;
          if (command?.type !== "thread.turn.start") {
            return null;
          }
          firstCommandId ??= command.commandId ?? null;
          firstMessageId ??= command.message?.messageId ?? null;
          return { type: "close" };
        };
      },
    });

    try {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, sentText);

      const sendButton = await waitForSendButton();
      await vi.waitFor(
        () => {
          expect(sendButton.disabled).toBe(false);
        },
        { timeout: 8_000, interval: 16 },
      );
      sendButton.click();

      const retryButton = await waitForButtonByText("Retry send");
      await vi.waitFor(
        () => {
          expect(firstMessageId).not.toBeNull();
          expect(document.querySelectorAll(`[data-message-id="${firstMessageId}"]`)).toHaveLength(
            1,
          );
        },
        { timeout: 12_000, interval: 16 },
      );

      retryButton.click();

      await vi.waitFor(
        () => {
          const dispatchRequests = getDispatchCommandRequests("thread.turn.start");
          expect(dispatchRequests).toHaveLength(2);
          const retriedCommand = dispatchRequests[1]?.command as
            | {
                commandId?: string;
                message?: { messageId?: MessageId };
              }
            | undefined;
          expect(retriedCommand?.commandId).toBe(firstCommandId);
          expect(retriedCommand?.message?.messageId).toBe(firstMessageId);
          expect(document.querySelectorAll(`[data-message-id="${firstMessageId}"]`)).toHaveLength(
            1,
          );
        },
        { timeout: 12_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("restores the draft prompt, image, and terminal context after an unresolved send", async () => {
    const otherThreadId = "thread-recovery-navigation" as ThreadId;
    const prompt = `Check this screenshot ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}`;
    const image = createComposerImageAttachment({
      id: "image-recovery",
      name: "recovery.svg",
    });
    const terminalContext = createTerminalContext({
      id: "ctx-recovery",
      terminalLabel: "Terminal 1",
      lineStart: 4,
      lineEnd: 7,
      text: "git status\nclean tree",
    });
    let pendingMessageId: MessageId | null = null;

    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });
    useComposerDraftStore.getState().setPrompt(THREAD_ID, prompt);
    useComposerDraftStore.getState().addImage(THREAD_ID, image);
    useComposerDraftStore.getState().addTerminalContext(THREAD_ID, terminalContext);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: addThreadToSnapshot(createDraftOnlySnapshot(), otherThreadId),
      configureFixture: (nextFixture) => {
        nextFixture.resolveWsRequest = (body) => {
          if (body._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand) {
            return null;
          }
          const command = body.command as
            | {
                type?: unknown;
                message?: { messageId?: MessageId };
              }
            | undefined;
          if (command?.type !== "thread.turn.start") {
            return null;
          }
          pendingMessageId = command.message?.messageId ?? null;
          return { type: "close" };
        };
      },
    });

    try {
      const sendButton = await waitForSendButton();
      await vi.waitFor(
        () => {
          expect(sendButton.disabled).toBe(false);
        },
        { timeout: 8_000, interval: 16 },
      );
      sendButton.click();

      await waitForButtonByText("Restore draft");
      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: otherThreadId },
      });
      await waitForURL(
        mounted.router,
        (pathname) => pathname === `/${otherThreadId}`,
        "Expected to navigate to the secondary thread.",
      );
      await mounted.router.navigate({
        to: "/$threadId",
        params: { threadId: THREAD_ID },
      });
      await waitForURL(
        mounted.router,
        (pathname) => pathname === `/${THREAD_ID}`,
        "Expected to navigate back to the original draft thread.",
      );

      const restoreButton = await waitForButtonByText("Restore draft");
      restoreButton.click();

      await vi.waitFor(
        () => {
          const draft = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID];
          expect(draft?.prompt).toBe(prompt);
          expect(draft?.images).toHaveLength(1);
          expect(draft?.images[0]?.previewUrl.startsWith("blob:")).toBe(true);
          expect(draft?.terminalContexts.map((context) => context.id)).toEqual([
            terminalContext.id,
          ]);
          expect(document.querySelector(`[data-message-id="${pendingMessageId}"]`)).toBeNull();
        },
        { timeout: 12_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the same recovery flow for plan follow-up sends", async () => {
    const planFollowUpSnapshot = createPlanFollowUpSnapshot();
    const unresolvedSnapshot = {
      ...planFollowUpSnapshot,
      threads: planFollowUpSnapshot.threads.map((thread) =>
        thread.id === THREAD_ID
          ? {
              ...thread,
              interactionMode: "default" as const,
            }
          : thread,
      ),
    };

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: planFollowUpSnapshot,
      configureFixture: (nextFixture) => {
        nextFixture.resolveWsRequest = (body) => {
          if (body._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand) {
            return null;
          }
          const command = body.command as { type?: unknown } | undefined;
          if (command?.type !== "thread.turn.start") {
            return null;
          }
          nextFixture.snapshot = unresolvedSnapshot;
          return { type: "close" };
        };
      },
    });

    try {
      const implementButton = await waitForButtonByText("Implement");
      implementButton.click();

      await waitForButtonByText("Retry send");
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.interactionMode).toBe(
        "default",
      );

      const restoreButton = await waitForButtonByText("Restore draft");
      restoreButton.click();

      await vi.waitFor(
        () => {
          expect(
            useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.interactionMode,
          ).toBe("plan");
        },
        { timeout: 12_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  // Regression for the LegendList port: empty threads that happen to have
  // tracked tasks used to hide the tasks panel because the panel was handed
  // to LegendList's `ListHeaderComponent`, which never renders when the list
  // has zero rows. The empty-state branch in MessagesTimeline must render
  // `listHeaderContent` alongside the "send a message to start..." copy.
  it("renders the tasks panel when the thread is empty but has tasks", async () => {
    const emptyThreadWithTasks: OrchestrationReadModel = {
      snapshotSequence: 1,
      projects: [
        {
          id: PROJECT_ID,
          title: "Project",
          workspaceRoot: "/repo/project",
          defaultModel: "gpt-5",
          scripts: [],
          memories: [],
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          deletedAt: null,
        },
      ],
      planningWorkflows: [],
      codeReviewWorkflows: [],
      threads: [
        {
          id: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Empty thread with tasks",
          model: "gpt-5",
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: "main",
          worktreePath: null,
          latestTurn: null,
          archivedAt: null,
          createdAt: NOW_ISO,
          lastInteractionAt: NOW_ISO,
          updatedAt: NOW_ISO,
          deletedAt: null,
          messages: [],
          activities: [],
          proposedPlans: [],
          tasks: [
            {
              id: "task-1",
              content: "Plan the feature",
              activeForm: "Planning the feature",
              status: "in_progress",
            },
            {
              id: "task-2",
              content: "Implement the feature",
              activeForm: "Implementing the feature",
              status: "pending",
            },
          ],
          tasksTurnId: null,
          tasksUpdatedAt: NOW_ISO,
          compaction: null,
          checkpoints: [],
          session: {
            threadId: THREAD_ID,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: NOW_ISO,
          },
        },
      ],
      updatedAt: NOW_ISO,
    };

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: emptyThreadWithTasks,
    });

    try {
      await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find((button) =>
            button.textContent?.includes("Task list"),
          ) as HTMLButtonElement | null,
        "Tasks panel must render even when the timeline is empty.",
      );

      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Send a message to start the conversation.");
        expect(document.body.textContent).toContain("Planning the feature");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  // Regression for the LegendList port: the plan required MessagesTimeline
  // to expose a stable selector for the scroll container (`data-slot=
  // "messages-scroll-container"`). Existing layout tests fall back to a
  // walk-up-the-DOM scroll finder (see `measureTimelineRow`); this test
  // asserts the stable slot exists so the ad-hoc finder is not the only
  // way to locate the container.
  it("exposes a stable scroll container slot for the LegendList timeline", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-slot" as MessageId,
        targetText: "slot target",
      }),
    });

    try {
      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-slot="messages-scroll-container"]'),
        "Messages scroll container slot must be present.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a historical file-change work row visible after syncing a newer user turn", async () => {
    const initialSnapshot = createSnapshotWithHistoricalFileChange();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: initialSnapshot,
    });

    try {
      await waitForElement(
        () => document.querySelector('[data-timeline-row-id="activity-remote-file-change"]'),
        "Historical file-change row should render before the newer user turn.",
      );

      const nextSnapshot = createSnapshotWithHistoricalFileChange({
        includeLaterUserMessage: true,
      });
      fixture.snapshot = nextSnapshot;
      useStore.getState().syncServerReadModel(nextSnapshot);
      await waitForLayout();

      await waitForElement(
        () => document.querySelector('[data-timeline-row-id="activity-remote-file-change"]'),
        "Historical file-change row should stay visible after the newer user turn syncs.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a historical file-change work row visible after live user-turn events", async () => {
    const initialSnapshot = createSnapshotWithHistoricalFileChange();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: initialSnapshot,
    });
    const nextTurnId = TurnId.makeUnsafe("turn-after-historical-file-change");

    try {
      await waitForElement(
        () => document.querySelector('[data-timeline-row-id="activity-remote-file-change"]'),
        "Historical file-change row should render before the live user-turn events.",
      );

      useStore.getState().applyDomainEvent({
        sequence: 2,
        eventId: EventId.makeUnsafe("event-thread-message-sent-live-next"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: isoAt(139),
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: THREAD_ID,
          messageId: "msg-user-after-file-change" as MessageId,
          role: "user",
          text: "ok, another one now",
          attachments: undefined,
          turnId: nextTurnId,
          streaming: false,
          createdAt: isoAt(139),
          updatedAt: isoAt(139),
        },
      });
      useStore.getState().applyDomainEvent({
        sequence: 3,
        eventId: EventId.makeUnsafe("event-thread-session-set-live-next"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: isoAt(139),
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.session-set",
        payload: {
          threadId: THREAD_ID,
          session: {
            threadId: THREAD_ID,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: nextTurnId,
            lastError: null,
            updatedAt: isoAt(139),
          },
        },
      });
      await waitForLayout();

      await waitForElement(
        () => document.querySelector('[data-timeline-row-id="activity-remote-file-change"]'),
        "Historical file-change row should stay visible after the live user-turn events.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a historical file-change work row visible after an optimistic composer send", async () => {
    const sentText = "optimistic send after historical file change";
    const initialSnapshot = createSnapshotWithHistoricalFileChange();
    const nextTurnId = TurnId.makeUnsafe("turn-after-historical-file-change-live");
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: initialSnapshot,
      configureFixture: (nextFixture) => {
        nextFixture.resolveWsRequest = (body) => {
          if (body._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand) {
            return null;
          }
          const command = body.command as { type?: unknown } | undefined;
          if (command?.type !== "thread.turn.start") {
            return null;
          }
          return { type: "result", result: null };
        };
      },
    });

    try {
      await scrollTimelineRowIntoView('[data-timeline-row-id="activity-remote-file-change"]');
      await waitForTimelineRowVisible(
        '[data-timeline-row-id="activity-remote-file-change"]',
        "Historical file-change row should be visible before the optimistic send.",
      );

      useComposerDraftStore.getState().setPrompt(THREAD_ID, sentText);

      const sendButton = await waitForSendButton();
      await vi.waitFor(
        () => {
          expect(sendButton.disabled).toBe(false);
        },
        { timeout: 8_000, interval: 16 },
      );
      sendButton.click();

      await vi.waitFor(
        () => {
          expect(getDispatchCommandRequests("thread.turn.start")).toHaveLength(1);
          expect(document.body.textContent).toContain(sentText);
        },
        { timeout: 8_000, interval: 16 },
      );
      useStore.getState().applyDomainEvent({
        sequence: 2,
        eventId: EventId.makeUnsafe("event-thread-session-set-optimistic-next"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: isoAt(140),
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.session-set",
        payload: {
          threadId: THREAD_ID,
          session: {
            threadId: THREAD_ID,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: nextTurnId,
            lastError: null,
            updatedAt: isoAt(140),
          },
        },
      });
      useStore.getState().applyDomainEvent({
        sequence: 3,
        eventId: EventId.makeUnsafe("event-thread-message-sent-optimistic-next-1"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: isoAt(141),
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: THREAD_ID,
          messageId: "msg-assistant-after-file-change-1" as MessageId,
          role: "assistant",
          text: "I found another clean tracked Markdown file.",
          attachments: undefined,
          turnId: nextTurnId,
          streaming: false,
          createdAt: isoAt(141),
          updatedAt: isoAt(141),
        },
      });
      useStore.getState().applyDomainEvent({
        sequence: 4,
        eventId: EventId.makeUnsafe("event-thread-message-sent-optimistic-next-2"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: isoAt(142),
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: THREAD_ID,
          messageId: "msg-assistant-after-file-change-2" as MessageId,
          role: "assistant",
          text: "I’m checking its header first, then I’ll insert the test-only line near the top.",
          attachments: undefined,
          turnId: nextTurnId,
          streaming: false,
          createdAt: isoAt(142),
          updatedAt: isoAt(142),
        },
      });
      await waitForLayout();
      await waitForTimelineRowVisible(
        '[data-timeline-row-id="activity-remote-file-change"]',
        "Historical file-change row should stay visible after the optimistic user message and next-turn assistant commentary are appended.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps an opened historical inline diff visible after an optimistic composer send", async () => {
    const sentText = "another one after opened inline diff";
    persistAppSettings({ showFileChangeDiffsInline: true });
    const initialSnapshot = createSnapshotWithHistoricalFileChange();
    const nextTurnId = TurnId.makeUnsafe("turn-after-historical-file-change-inline-live");
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: initialSnapshot,
      configureFixture: (nextFixture) => {
        nextFixture.resolveWsRequest = (body) => {
          if (body._tag === ORCHESTRATION_WS_METHODS.getTurnDiff) {
            return {
              type: "result",
              result: {
                diff: [
                  "diff --git a/REMOTE.md b/REMOTE.md",
                  "index 1111111..2222222 100644",
                  "--- a/REMOTE.md",
                  "+++ b/REMOTE.md",
                  "@@ -1,2 +1,4 @@",
                  " # Remote Access Setup",
                  " ",
                  "+Sample inline diff change.",
                  "+",
                ].join("\n"),
              },
            };
          }
          if (body._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand) {
            return null;
          }
          const command = body.command as { type?: unknown } | undefined;
          if (command?.type !== "thread.turn.start") {
            return null;
          }
          return { type: "result", result: null };
        };
      },
    });

    try {
      await waitForElement(
        () =>
          document.querySelector(
            '[data-testid="inline-file-diff"][data-work-entry-id="activity-remote-file-change"]',
          ),
        "Historical inline diff should render before the optimistic send.",
      );
      await scrollTimelineRowIntoView('[data-timeline-row-id="activity-remote-file-change"]');
      await waitForTimelineRowVisible(
        '[data-timeline-row-id="activity-remote-file-change"]',
        "Historical file-change row should be visible before the optimistic send with an opened inline diff.",
      );

      useComposerDraftStore.getState().setPrompt(THREAD_ID, sentText);

      const sendButton = await waitForSendButton();
      await vi.waitFor(
        () => {
          expect(sendButton.disabled).toBe(false);
        },
        { timeout: 8_000, interval: 16 },
      );
      sendButton.click();

      useStore.getState().applyDomainEvent({
        sequence: 2,
        eventId: EventId.makeUnsafe("event-thread-session-set-optimistic-inline-next"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: isoAt(140),
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.session-set",
        payload: {
          threadId: THREAD_ID,
          session: {
            threadId: THREAD_ID,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: nextTurnId,
            lastError: null,
            updatedAt: isoAt(140),
          },
        },
      });
      useStore.getState().applyDomainEvent({
        sequence: 3,
        eventId: EventId.makeUnsafe("event-thread-message-sent-optimistic-inline-next-1"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: isoAt(141),
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: THREAD_ID,
          messageId: "msg-assistant-inline-after-file-change-1" as MessageId,
          role: "assistant",
          text: "I found another clean tracked Markdown file.",
          attachments: undefined,
          turnId: nextTurnId,
          streaming: false,
          createdAt: isoAt(141),
          updatedAt: isoAt(141),
        },
      });
      useStore.getState().applyDomainEvent({
        sequence: 4,
        eventId: EventId.makeUnsafe("event-thread-message-sent-optimistic-inline-next-2"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: isoAt(142),
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: THREAD_ID,
          messageId: "msg-assistant-inline-after-file-change-2" as MessageId,
          role: "assistant",
          text: "I’m checking its header first, then I’ll insert the test-only line near the top.",
          attachments: undefined,
          turnId: nextTurnId,
          streaming: false,
          createdAt: isoAt(142),
          updatedAt: isoAt(142),
        },
      });
      await waitForLayout();
      await waitForTimelineRowVisible(
        '[data-timeline-row-id="activity-remote-file-change"]',
        "Historical file-change row should stay visible after the optimistic user message and next-turn assistant commentary are appended.",
      );
      await waitForTimelineRowVisible(
        '[data-testid="inline-file-diff"][data-work-entry-id="activity-remote-file-change"]',
        "Historical inline diff should stay visible after the optimistic user message and next-turn assistant commentary are appended.",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps an opened historical inline diff visible after live user-turn events", async () => {
    persistAppSettings({ showFileChangeDiffsInline: true });
    fixture.resolveWsRequest = (body) => {
      if (body._tag === ORCHESTRATION_WS_METHODS.getTurnDiff) {
        return {
          type: "result",
          result: {
            diff: [
              "diff --git a/REMOTE.md b/REMOTE.md",
              "index 1111111..2222222 100644",
              "--- a/REMOTE.md",
              "+++ b/REMOTE.md",
              "@@ -1,2 +1,4 @@",
              " # Remote Access Setup",
              " ",
              "+Sample inline diff change.",
              "+",
            ].join("\n"),
          },
        };
      }
      return null;
    };

    const initialSnapshot = createSnapshotWithHistoricalFileChange();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: initialSnapshot,
    });
    const nextTurnId = TurnId.makeUnsafe("turn-after-historical-file-change");

    try {
      await waitForElement(
        () =>
          document.querySelector(
            '[data-testid="inline-file-diff"][data-work-entry-id="activity-remote-file-change"]',
          ),
        "Historical inline diff should render before the live user-turn events.",
      );

      useStore.getState().applyDomainEvent({
        sequence: 2,
        eventId: EventId.makeUnsafe("event-thread-message-sent-live-next-inline"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: isoAt(139),
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: THREAD_ID,
          messageId: "msg-user-after-file-change-inline" as MessageId,
          role: "user",
          text: "ok, another one now",
          attachments: undefined,
          turnId: nextTurnId,
          streaming: false,
          createdAt: isoAt(139),
          updatedAt: isoAt(139),
        },
      });
      useStore.getState().applyDomainEvent({
        sequence: 3,
        eventId: EventId.makeUnsafe("event-thread-session-set-live-next-inline"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: isoAt(139),
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.session-set",
        payload: {
          threadId: THREAD_ID,
          session: {
            threadId: THREAD_ID,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: nextTurnId,
            lastError: null,
            updatedAt: isoAt(139),
          },
        },
      });
      await waitForLayout();

      await waitForElement(
        () =>
          document.querySelector(
            '[data-testid="inline-file-diff"][data-work-entry-id="activity-remote-file-change"]',
          ),
        "Historical inline diff should stay visible after the live user-turn events.",
      );
    } finally {
      delete fixture.resolveWsRequest;
      await mounted.cleanup();
    }
  });

  it("renders fallback inline diffs for Claude-style file-change activities with empty changedFiles", async () => {
    persistAppSettings({ showFileChangeDiffsInline: true });
    fixture.resolveWsRequest = (body) => {
      if (body._tag !== ORCHESTRATION_WS_METHODS.getTurnDiff) {
        return null;
      }
      return {
        type: "result",
        result: {
          diff: [
            "diff --git a/REMOTE.md b/REMOTE.md",
            "index 1111111..2222222 100644",
            "--- a/REMOTE.md",
            "+++ b/REMOTE.md",
            "@@ -1,2 +1,4 @@",
            " # Remote Access Setup",
            " ",
            "+Sample inline diff change.",
            "+",
          ].join("\n"),
        },
      };
    };

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithHistoricalFileChange({
        activityChangedFiles: [],
      }),
    });

    try {
      await waitForElement(
        () =>
          document.querySelector(
            '[data-testid="inline-file-diff"][data-work-entry-id="activity-remote-file-change"]',
          ),
        "Claude-style historical inline diff should render from the checkpoint fallback.",
      );
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("REMOTE.md");
        expect(document.body.textContent).toContain("Sample inline diff change.");
      });
    } finally {
      delete fixture.resolveWsRequest;
      await mounted.cleanup();
    }
  });

  it("recovers an inline fallback diff after a later turn-diff completion event", async () => {
    persistAppSettings({ showFileChangeDiffsInline: true });
    let connectedClient: TestWsClient | null = null;
    let checkpointReady = false;
    let turnDiffRequestCount = 0;
    const historicalTurnId = TurnId.makeUnsafe("turn-historical-file-change");
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithHistoricalFileChange(),
      configureFixture: (nextFixture) => {
        nextFixture.resolveWsRequest = (body, client) => {
          connectedClient = client;
          if (body._tag !== ORCHESTRATION_WS_METHODS.getTurnDiff) {
            return null;
          }
          turnDiffRequestCount += 1;
          if (!checkpointReady) {
            return {
              type: "error",
              message:
                "Filesystem checkpoint is unavailable for turn 2 in thread thread-browser-test.",
            };
          }
          return {
            type: "result",
            result: {
              diff: [
                "diff --git a/REMOTE.md b/REMOTE.md",
                "index 1111111..2222222 100644",
                "--- a/REMOTE.md",
                "+++ b/REMOTE.md",
                "@@ -1,2 +1,4 @@",
                " # Remote Access Setup",
                " ",
                "+Sample inline diff change.",
                "+",
              ].join("\n"),
            },
          };
        };
      },
    });

    try {
      await waitForElement(
        () =>
          document.querySelector(
            '[data-testid="inline-file-diff"][data-work-entry-id="activity-remote-file-change"]',
          ),
        "Historical inline diff container should render before the checkpoint becomes available.",
      );
      await vi.waitFor(() => {
        expect(turnDiffRequestCount).toBeGreaterThan(0);
        expect(document.body.textContent).toContain("Diff unavailable");
      });

      const attemptsBeforeCheckpointEvent = turnDiffRequestCount;
      checkpointReady = true;

      await vi.waitFor(() => {
        expect(connectedClient).not.toBeNull();
      });
      const client = connectedClient;
      if (client === null) {
        throw new Error("Expected the test WebSocket client to be connected.");
      }
      const connectedWsClient = client as TestWsClient;
      connectedWsClient.send(
        JSON.stringify({
          type: "push",
          sequence: 2,
          channel: ORCHESTRATION_WS_CHANNELS.domainEvent,
          data: {
            sequence: 2,
            eventId: EventId.makeUnsafe("event-turn-diff-completed-inline-refresh"),
            aggregateKind: "thread",
            aggregateId: THREAD_ID,
            occurredAt: isoAt(121),
            commandId: CommandId.makeUnsafe("cmd-turn-diff-completed-inline-refresh"),
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "thread.turn-diff-completed",
            payload: {
              threadId: THREAD_ID,
              turnId: historicalTurnId,
              checkpointTurnCount: 2,
              checkpointRef:
                "checkpoint-historical-file-change" as OrchestrationReadModel["threads"][number]["checkpoints"][number]["checkpointRef"],
              status: "ready",
              files: [
                {
                  path: "REMOTE.md",
                  kind: "modified",
                  additions: 2,
                  deletions: 0,
                },
              ],
              assistantMessageId: "msg-assistant-file-summary" as MessageId,
              completedAt: isoAt(121),
            },
          } satisfies Extract<OrchestrationEvent, { type: "thread.turn-diff-completed" }>,
        }),
      );

      await vi.waitFor(() => {
        expect(turnDiffRequestCount).toBeGreaterThan(attemptsBeforeCheckpointEvent);
        expect(document.body.textContent).toContain("Sample inline diff change.");
        expect(document.body.textContent).not.toContain("Diff unavailable");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps an opened inline diff visible when the turn settles before later assistant messages", async () => {
    persistAppSettings({ showFileChangeDiffsInline: true });
    fixture.resolveWsRequest = (body) => {
      if (body._tag === ORCHESTRATION_WS_METHODS.getTurnDiff) {
        return {
          type: "result",
          result: {
            diff: [
              "diff --git a/.docs/ci.md b/.docs/ci.md",
              "index 1111111..2222222 100644",
              "--- a/.docs/ci.md",
              "+++ b/.docs/ci.md",
              "@@ -1,2 +1,4 @@",
              " # CI quality gates",
              " ",
              "+Sample inline diff change.",
              "+",
            ].join("\n"),
          },
        };
      }
      return null;
    };

    const initialSnapshot = createSnapshotWithSettlingInlineFileChange();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: initialSnapshot,
    });

    try {
      await waitForElement(
        () =>
          document.querySelector(
            '[data-testid="inline-file-diff"][data-work-entry-id="activity-inline-settling-file-change"]',
          ),
        "Inline diff should render before the turn settles.",
      );
      await scrollTimelineRowIntoView(
        '[data-timeline-row-id="activity-inline-settling-file-change"]',
      );
      await waitForTimelineRowVisible(
        '[data-timeline-row-id="activity-inline-settling-file-change"]',
        "Inline diff row should be visible before the turn settles.",
      );

      const settledSnapshot = createSnapshotWithSettlingInlineFileChange({ settled: true });
      fixture.snapshot = settledSnapshot;
      useStore.getState().syncServerReadModel(settledSnapshot);
      await waitForLayout();

      await waitForElement(
        () =>
          document.querySelector(
            '[data-testid="inline-file-diff"][data-work-entry-id="activity-inline-settling-file-change"]',
          ),
        "Inline diff should stay visible after the turn settles mid-stream.",
      );
    } finally {
      delete fixture.resolveWsRequest;
      await mounted.cleanup();
    }
  });

  it("keeps long proposed plans lightweight until the user expands them", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithLongProposedPlan(),
    });

    try {
      await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Expand plan",
          ) as HTMLButtonElement | null,
        "Unable to find Expand plan button.",
      );

      expect(document.body.textContent).not.toContain("deep hidden detail only after expand");

      const expandButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Expand plan",
          ) as HTMLButtonElement | null,
        "Unable to find Expand plan button.",
      );
      expandButton.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("deep hidden detail only after expand");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });
});
