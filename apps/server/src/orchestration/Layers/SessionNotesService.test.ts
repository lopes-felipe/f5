import {
  CommandId,
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";

import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { SessionNotesService } from "../Services/SessionNotesService.ts";
import { SessionNotesServiceLive } from "./SessionNotesService.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const NOW = "2026-04-08T10:00:00.000Z";

function makeReadModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: NOW,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModel: null,
        scripts: [],
        memories: [],
        skills: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    planningWorkflows: [],
    codeReviewWorkflows: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Claude thread",
        model: "claude-sonnet-4-6",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        archivedAt: null,
        createdAt: NOW,
        lastInteractionAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
        messages: [
          {
            id: MessageId.makeUnsafe("message-1"),
            role: "user",
            text: "Summarize this session",
            streaming: false,
            turnId: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        proposedPlans: [],
        tasks: [],
        tasksTurnId: null,
        tasksUpdatedAt: null,
        activities: [],
        checkpoints: [],
        compaction: null,
        sessionNotes: null,
        threadReferences: [],
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      },
    ],
  };
}

function makeSessionSetEvent(
  status: "running" | "ready",
): Extract<OrchestrationEvent, { type: "thread.session-set" }> {
  return {
    sequence: 1,
    eventId: EventId.makeUnsafe(`event-${status}`),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.session-set",
    occurredAt: NOW,
    commandId: CommandId.makeUnsafe(`cmd-${status}`),
    causationEventId: null,
    correlationId: CommandId.makeUnsafe(`corr-${status}`),
    metadata: {},
    payload: {
      threadId: THREAD_ID,
      session: {
        threadId: THREAD_ID,
        status,
        providerName: "claudeAgent",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: NOW,
      },
    },
  };
}

async function createHarness(input: {
  readonly runOneOffPrompt: ProviderServiceShape["runOneOffPrompt"];
}) {
  const domainEventPubSub = Effect.runSync(PubSub.unbounded<OrchestrationEvent>());
  let readModel = makeReadModel();
  const dispatched: OrchestrationCommand[] = [];

  const orchestrationEngine: OrchestrationEngineShape = {
    getReadModel: () => Effect.succeed(readModel),
    readEvents: () => Stream.empty,
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        if (command.type === "thread.session-notes.record") {
          const nextThreads = [...readModel.threads];
          const threadIndex = nextThreads.findIndex((thread) => thread.id === command.threadId);
          if (threadIndex >= 0) {
            const nextThread = nextThreads[threadIndex];
            if (nextThread) {
              nextThreads[threadIndex] = Object.assign({}, nextThread, {
                sessionNotes: command.sessionNotes,
              });
            }
          }
          readModel = {
            ...readModel,
            threads: nextThreads,
          };
        }
        return { sequence: dispatched.length };
      }),
    streamDomainEvents: Stream.fromPubSub(domainEventPubSub),
  };

  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
  const providerService: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => Effect.void,
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "restart-session" }),
    readThread: () => unsupported(),
    rollbackConversation: () => unsupported(),
    runOneOffPrompt: input.runOneOffPrompt,
    compactConversation: () => unsupported(),
    reloadMcpConfigForProject: () => unsupported(),
    streamEvents: Stream.empty,
  };

  const runtime = ManagedRuntime.make(
    SessionNotesServiceLive.pipe(
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, orchestrationEngine)),
      Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
    ),
  );
  const service = await runtime.runPromise(Effect.service(SessionNotesService));
  const scope = await Effect.runPromise(Scope.make("sequential"));
  await Effect.runPromise(service.start.pipe(Scope.provide(scope)));
  await new Promise((resolve) => setTimeout(resolve, 0));

  return {
    service,
    dispatched,
    emit: (event: OrchestrationEvent) => Effect.runSync(PubSub.publish(domainEventPubSub, event)),
    mutateReadModel: (mutator: (current: OrchestrationReadModel) => OrchestrationReadModel) => {
      readModel = mutator(readModel);
    },
    dispose: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    },
  };
}

describe("SessionNotesService", () => {
  const disposers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  });

  it("records normalized session notes for settled Claude threads", async () => {
    const harness = await createHarness({
      runOneOffPrompt: () =>
        Effect.succeed({
          text: JSON.stringify({
            title: "T".repeat(160),
            currentState: ` ${"A".repeat(2_100)} `,
            taskSpecification: "task",
            filesAndFunctions: "files",
            workflow: "workflow",
            errorsAndCorrections: "errors",
            codebaseAndSystemDocumentation: "docs",
            learnings: "learnings",
            keyResults: "results",
            worklog: "worklog",
            updatedAt: "ignored",
            sourceLastInteractionAt: "ignored",
          }),
        }),
    });
    disposers.push(harness.dispose);

    harness.emit(makeSessionSetEvent("ready"));
    await Effect.runPromise(harness.service.drain);

    const recordCommand = harness.dispatched.find(
      (
        command,
      ): command is Extract<OrchestrationCommand, { type: "thread.session-notes.record" }> =>
        command.type === "thread.session-notes.record",
    );

    expect(recordCommand).toBeDefined();
    expect(recordCommand?.sessionNotes.title.length).toBeLessThanOrEqual(120);
    expect(recordCommand?.sessionNotes.currentState.length).toBeLessThanOrEqual(2_000);
    expect(recordCommand?.sessionNotes.sourceLastInteractionAt).toBe(NOW);
  });

  it("ignores invalid JSON responses", async () => {
    let runOneOffPromptCalls = 0;
    const harness = await createHarness({
      runOneOffPrompt: () =>
        Effect.sync(() => {
          runOneOffPromptCalls += 1;
          return {
            text: "not-json",
          };
        }),
    });
    disposers.push(harness.dispose);

    harness.emit(makeSessionSetEvent("ready"));
    await Effect.runPromise(harness.service.drain);

    // Initial attempt + one retry with a stricter reminder.
    expect(runOneOffPromptCalls).toBe(2);
    expect(
      harness.dispatched.some((command) => command.type === "thread.session-notes.record"),
    ).toBe(false);
  });

  it("tolerates conversational prose surrounding the JSON payload", async () => {
    const notesPayload = {
      title: "Preamble notes",
      currentState: "State",
      taskSpecification: "Task",
      filesAndFunctions: "Files",
      workflow: "Workflow",
      errorsAndCorrections: "Errors",
      codebaseAndSystemDocumentation: "Docs",
      learnings: "Learnings",
      keyResults: "Results",
      worklog: "Worklog",
      updatedAt: "ignored",
      sourceLastInteractionAt: "ignored",
    };
    let runOneOffPromptCalls = 0;
    const harness = await createHarness({
      runOneOffPrompt: () =>
        Effect.sync(() => {
          runOneOffPromptCalls += 1;
          return {
            text: `I'd be happy to help! Here are the notes:\n${JSON.stringify(notesPayload)}\nLet me know if you need anything else.`,
          };
        }),
    });
    disposers.push(harness.dispose);

    harness.emit(makeSessionSetEvent("ready"));
    await Effect.runPromise(harness.service.drain);

    // Tolerant extraction should succeed on the first call, so no retry.
    expect(runOneOffPromptCalls).toBe(1);
    const recordCommand = harness.dispatched.find(
      (
        command,
      ): command is Extract<OrchestrationCommand, { type: "thread.session-notes.record" }> =>
        command.type === "thread.session-notes.record",
    );
    expect(recordCommand?.sessionNotes.title).toBe("Preamble notes");
  });

  it("retries with a stricter reminder when the first response is not JSON", async () => {
    const notesPayload = {
      title: "Retry notes",
      currentState: "State",
      taskSpecification: "Task",
      filesAndFunctions: "Files",
      workflow: "Workflow",
      errorsAndCorrections: "Errors",
      codebaseAndSystemDocumentation: "Docs",
      learnings: "Learnings",
      keyResults: "Results",
      worklog: "Worklog",
      updatedAt: "ignored",
      sourceLastInteractionAt: "ignored",
    };
    const prompts: string[] = [];
    const harness = await createHarness({
      runOneOffPrompt: (input) =>
        Effect.sync(() => {
          prompts.push(input.prompt);
          return prompts.length === 1
            ? { text: "I'd be happy to help, but I cannot produce JSON right now." }
            : { text: JSON.stringify(notesPayload) };
        }),
    });
    disposers.push(harness.dispose);

    harness.emit(makeSessionSetEvent("ready"));
    await Effect.runPromise(harness.service.drain);

    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain("Respond with ONLY a single JSON object");
    const recordCommand = harness.dispatched.find(
      (
        command,
      ): command is Extract<OrchestrationCommand, { type: "thread.session-notes.record" }> =>
        command.type === "thread.session-notes.record",
    );
    expect(recordCommand?.sessionNotes.title).toBe("Retry notes");
  });

  it("does not refresh notes while the thread is still running", async () => {
    let runOneOffPromptCalls = 0;
    const harness = await createHarness({
      runOneOffPrompt: () =>
        Effect.sync(() => {
          runOneOffPromptCalls += 1;
          return {
            text: "{}",
          };
        }),
    });
    disposers.push(harness.dispose);

    harness.emit(makeSessionSetEvent("running"));
    await Effect.runPromise(harness.service.drain);

    expect(runOneOffPromptCalls).toBe(0);
    expect(
      harness.dispatched.some((command) => command.type === "thread.session-notes.record"),
    ).toBe(false);
  });

  it("refreshes notes for non-Claude threads using the inferred provider", async () => {
    let requestedProvider: string | null = null;
    let requestedRuntimeMode: string | null = null;
    const harness = await createHarness({
      runOneOffPrompt: (input) =>
        Effect.sync(() => {
          requestedProvider = input.provider;
          requestedRuntimeMode = input.runtimeMode ?? null;
          return {
            text: JSON.stringify({
              title: "Codex notes",
              currentState: "State",
              taskSpecification: "Task",
              filesAndFunctions: "Files",
              workflow: "Workflow",
              errorsAndCorrections: "Errors",
              codebaseAndSystemDocumentation: "Docs",
              learnings: "Learnings",
              keyResults: "Results",
              worklog: "Worklog",
              updatedAt: "ignored",
              sourceLastInteractionAt: "ignored",
            }),
          };
        }),
    });
    disposers.push(harness.dispose);

    harness.mutateReadModel((current) => ({
      ...current,
      threads: current.threads.map((thread) =>
        thread.id === THREAD_ID
          ? {
              ...thread,
              title: "Codex thread",
              model: "gpt-5.3-codex",
              runtimeMode: "approval-required",
              session: thread.session
                ? {
                    ...thread.session,
                    providerName: "codex",
                  }
                : null,
            }
          : thread,
      ),
    }));

    harness.emit(makeSessionSetEvent("ready"));
    await Effect.runPromise(harness.service.drain);

    expect(requestedProvider).toBe("codex");
    expect(requestedRuntimeMode).toBe("approval-required");
    expect(
      harness.dispatched.some((command) => command.type === "thread.session-notes.record"),
    ).toBe(true);
  });

  it("uses a safe Codex one-off model for OpenCode session notes", async () => {
    const requests: Array<{ provider: string; model: string | undefined }> = [];
    const harness = await createHarness({
      runOneOffPrompt: (input) =>
        Effect.sync(() => {
          requests.push({ provider: input.provider, model: input.model });
          return {
            text: JSON.stringify({
              title: "OpenCode notes",
              currentState: "State",
              taskSpecification: "Task",
              filesAndFunctions: "Files",
              workflow: "Workflow",
              errorsAndCorrections: "Errors",
              codebaseAndSystemDocumentation: "Docs",
              learnings: "Learnings",
              keyResults: "Results",
              worklog: "Worklog",
              updatedAt: "ignored",
              sourceLastInteractionAt: "ignored",
            }),
          };
        }),
    });
    disposers.push(harness.dispose);

    harness.mutateReadModel((current) => ({
      ...current,
      threads: current.threads.map((thread) =>
        thread.id === THREAD_ID
          ? {
              ...thread,
              title: "OpenCode thread",
              model: "opencode/big-pickle",
              session: thread.session
                ? {
                    ...thread.session,
                    providerName: "opencode",
                  }
                : null,
            }
          : thread,
      ),
    }));

    harness.emit(makeSessionSetEvent("ready"));
    await Effect.runPromise(harness.service.drain);

    expect(requests).toEqual([
      {
        provider: "codex",
        model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
      },
    ]);
    expect(
      harness.dispatched.some((command) => command.type === "thread.session-notes.record"),
    ).toBe(true);
  });
});
