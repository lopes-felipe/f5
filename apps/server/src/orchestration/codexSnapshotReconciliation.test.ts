import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationCommandExecutionId,
  ProjectId,
  ProviderInstanceId,
  ProviderItemId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { Effect, Option } from "effect";
import { expect, it } from "vitest";
import { createPersistentOrchestrationSystem } from "./testUtils/persistentOrchestration.ts";
import {
  CODEX_PERSISTENCE_TRUNCATION_MARKER,
  planCommandOutputRepair,
  reconcileCodexThreadSnapshots,
} from "./codexSnapshotReconciliation.ts";
import type { ProviderRuntimeBindingWithMetadata } from "../provider/Services/ProviderSessionDirectory.ts";
import type { ProviderThreadSnapshot } from "../provider/Services/ProviderAdapter.ts";

type CommandInput<C = OrchestrationCommand> = C extends OrchestrationCommand
  ? Omit<C, "commandId">
  : never;

it.each([
  "complete",
  "legacy-backfill",
  "partial",
  "different-identity",
  "divergent",
  "tool",
  "reasoning",
  "replaced",
  "deleted",
] as const)(
  "verifies %s native history before reopening turn admission",
  async (mode) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-history-reconciliation-"));
    const system = await createPersistentOrchestrationSystem({
      dbPath: path.join(directory, "state.sqlite"),
    });
    const threadId = ThreadId.makeUnsafe("incomplete-thread"),
      turnId = TurnId.makeUnsafe("incomplete-turn");
    const messageId = MessageId.makeUnsafe("assistant:native-item"),
      projectId = ProjectId.makeUnsafe("project");
    const instanceId = ProviderInstanceId.make("codex");
    const createdAt = "2026-10-19T00:00:00.000Z";
    let command = 0;
    const dispatch = (input: CommandInput) =>
      system.run(
        system.engine.dispatch({
          ...input,
          commandId: CommandId.makeUnsafe(`reconcile-test:${++command}`),
        } as OrchestrationCommand),
      );
    let binding: ProviderRuntimeBindingWithMetadata = {
      threadId,
      provider: "codex",
      providerInstanceId: instanceId,
      lastSeenAt: createdAt,
      runtimePayload: {
        sessionGeneration: 1,
        historyReconciliationRequired: {
          eventId: "lost",
          turnId,
          historyIdentity: "native-thread",
        },
      },
    };
    if (mode === "legacy-backfill")
      binding = { ...binding, runtimePayload: { sessionGeneration: 1 } };
    let acknowledged = false;
    const snapshot: ProviderThreadSnapshot = {
      threadId,
      history: {
        identity: mode === "different-identity" ? "other-thread" : "native-thread",
        provenance: "provider-persisted",
        coverage: mode === "partial" ? "partial" : "complete",
        boundary: turnId,
        runtimeId: null,
        origin: { instanceId, generation: 1 },
      },
      turns: [
        {
          id: turnId,
          items: [
            {
              type: "agentMessage",
              id: "native-item",
              text: mode === "divergent" ? "different" : " prefix suffix\n ",
            },
            ...(mode === "tool"
              ? [{ type: "commandExecution", id: "cmd", command: "echo x" }]
              : mode === "reasoning"
                ? [{ type: "reasoning", summary: [{ type: "summary_text", text: "reason" }] }]
                : []),
          ],
        },
      ],
    };
    try {
      await dispatch({
        type: "project.create",
        projectId,
        title: "Project",
        workspaceRoot: directory,
        defaultModel: "gpt-5-codex",
        createdAt,
      });
      await dispatch({
        type: "thread.create",
        threadId,
        projectId,
        title: "Thread",
        model: "gpt-5-codex",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      await dispatch({
        type: "thread.turn.start",
        threadId,
        message: {
          messageId: MessageId.makeUnsafe("user"),
          role: "user",
          text: "work",
          attachments: [],
        },
        assistantDeliveryMode: "streaming",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt,
      });
      const session = {
        threadId,
        providerName: "codex" as const,
        providerInstanceId: instanceId,
        runtimeMode: "full-access" as const,
        lastError: null,
        updatedAt: createdAt,
      };
      await dispatch({
        type: "thread.session.set",
        threadId,
        session: { ...session, status: "running", activeTurnId: turnId },
        createdAt,
      });
      await dispatch({
        type: "thread.message.assistant.delta",
        threadId,
        messageId,
        turnId,
        delta: " prefix",
        createdAt,
      });
      if (mode !== "legacy-backfill")
        await dispatch({
          type: "thread.message.assistant.complete",
          threadId,
          messageId,
          turnId,
          createdAt,
        });
      await dispatch({
        type: "thread.session.set",
        threadId,
        session: {
          ...session,
          status: "error",
          activeTurnId: null,
          lastError: "Incomplete output",
        },
        createdAt,
      });
      const head = (await system.run(system.engine.getReadModel())).snapshotSequence;
      const reconcile = () =>
        system.run(
          reconcileCodexThreadSnapshots(
            {
              orchestrationEngine: system.engine,
              threadCommandExecutionQuery: system.threadCommandExecutionQuery,
              providerSessionDirectory: { getBinding: () => Effect.succeed(Option.some(binding)) },
              providerService: {
                readThread: () =>
                  Effect.promise(async () => {
                    if (mode === "replaced")
                      binding = {
                        ...binding,
                        runtimePayload: {
                          ...(binding.runtimePayload as object),
                          sessionGeneration: 2,
                        },
                      };
                    if (mode === "deleted") await dispatch({ type: "thread.delete", threadId });
                    return snapshot;
                  }),
                acknowledgeHistoryReconciliation: (input) =>
                  Effect.sync(() => {
                    expect(input).toMatchObject({
                      markerId: "lost",
                      historyIdentity: "native-thread",
                      instanceId,
                      generation: 1,
                    });
                    acknowledged = true;
                    binding = { ...binding, runtimePayload: { sessionGeneration: 1 } };
                    return true;
                  }),
              },
            },
            { threadIds: [threadId], reason: "overload", mode: "complete-or-extend", createdAt },
          ),
        );
      await reconcile();
      const state = await system.run(system.engine.getReadModel());
      const message = state.threads[0]!.messages.find((message) => message.id === messageId)!;
      expect(acknowledged).toBe(mode === "complete");
      if (mode === "deleted") {
        expect(message).toBeUndefined();
        return;
      }
      expect(message.text).toBe(
        mode === "complete" || mode === "legacy-backfill" ? " prefix suffix\n " : " prefix",
      );
      expect(message.streaming).toBe(false);
      if (mode === "complete" || mode === "legacy-backfill") {
        await reconcile();
        expect((await system.run(system.engine.getReadModel())).snapshotSequence).toBe(
          state.snapshotSequence,
        );
      } else expect(state.snapshotSequence).toBe(head);
    } finally {
      await system.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  10_000,
);

const TOOL_HISTORY_MODES = [
  "complete",
  "codex-truncated",
  "codex-truncated-longer",
  "divergent-output",
  "missing-tool-completed",
  "reasoning-text",
  "file-change",
  "missing-row",
  "running-row",
  "truncated-row",
  "turn-mismatch",
  "stale-sequence",
] as const;

it.each(TOOL_HISTORY_MODES)(
  "verifies %s tool-containing native history before reopening turn admission",
  async (mode) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-tool-history-"));
    const system = await createPersistentOrchestrationSystem({
      dbPath: path.join(directory, "state.sqlite"),
    });
    const threadId = ThreadId.makeUnsafe("tool-thread"),
      turnId = TurnId.makeUnsafe("tool-turn"),
      projectId = ProjectId.makeUnsafe("project");
    const instanceId = ProviderInstanceId.make("codex");
    const createdAt = "2026-11-08T21:16:56.000Z";
    const commandItemId = mode === "missing-row" ? "exec-unknown" : "exec-1";
    const commandExecutionId = OrchestrationCommandExecutionId.makeUnsafe(
      `cmdexec:${threadId}:exec-1`,
    );
    const head = "head-line\n".repeat(20);
    const codexTruncated = mode === "codex-truncated" || mode === "codex-truncated-longer";
    // F5 streamed less than Codex's saved head, or (longer) more than it.
    const streamed =
      mode === "divergent-output"
        ? "unrelated\n"
        : mode === "codex-truncated-longer"
          ? `${head}more streamed\n`
          : "head-line\n";
    const fullOutput = codexTruncated
      ? `${head}${CODEX_PERSISTENCE_TRUNCATION_MARKER}tail-line\n`
      : `${"head-line\n".repeat(20)}done\n`;
    // A longer streamed prefix is kept whole, followed by Codex's marker and tail.
    const repairedOutput =
      mode === "codex-truncated-longer"
        ? `${streamed}${CODEX_PERSISTENCE_TRUNCATION_MARKER}tail-line\n`
        : fullOutput;
    let command = 0;
    let injectAppend = mode === "stale-sequence";
    const dispatch = (input: CommandInput) =>
      system.run(
        system.engine.dispatch({
          ...input,
          commandId: CommandId.makeUnsafe(`tool-test:${++command}`),
        } as OrchestrationCommand),
      );
    const engine: typeof system.engine = {
      ...system.engine,
      dispatch: (input) =>
        Effect.gen(function* () {
          if (injectAppend && input.type === "thread.command-execution.output.reconcile") {
            injectAppend = false;
            // Newer streamed output lands between preflight and repair.
            yield* system.engine.dispatch({
              type: "thread.command-execution.output.append",
              commandId: CommandId.makeUnsafe("tool-test:late-output"),
              threadId,
              commandExecutionId,
              chunk: "late\n",
              updatedAt: createdAt,
              createdAt,
            });
          }
          return yield* system.engine.dispatch(input);
        }),
    };
    const binding: ProviderRuntimeBindingWithMetadata = {
      threadId,
      provider: "codex",
      providerInstanceId: instanceId,
      lastSeenAt: createdAt,
      runtimePayload: {
        sessionGeneration: 1,
        historyReconciliationRequired: {
          eventId: "incomplete:lost",
          turnId,
          historyIdentity: "native-thread",
        },
      },
    };
    let acknowledgements = 0;
    const snapshot: ProviderThreadSnapshot = {
      threadId,
      history: {
        identity: "native-thread",
        provenance: "provider-persisted",
        coverage: "complete",
        boundary: turnId,
        runtimeId: null,
        origin: { instanceId, generation: 1 },
      },
      turns: [
        {
          id: turnId,
          items: [
            { type: "userMessage", id: "user-item", content: [{ type: "text", text: "work" }] },
            { type: "reasoning", id: "reasoning-1", summary: [], content: [] },
            {
              type: "commandExecution",
              id: commandItemId,
              command: "ls",
              status: "completed",
              aggregatedOutput: fullOutput,
            },
            { type: "mcpToolCall", id: "mcp-1", server: "docs", tool: "read", status: "completed" },
            ...(mode === "reasoning-text"
              ? [{ type: "reasoning", id: "reasoning-2", summary: [{ type: "text", text: "x" }] }]
              : []),
            ...(mode === "file-change"
              ? [{ type: "fileChange", id: "patch-1", status: "completed", changes: [] }]
              : []),
            { type: "agentMessage", id: "native-item", text: " prefix suffix" },
          ],
        },
      ],
    };
    try {
      await dispatch({
        type: "project.create",
        projectId,
        title: "Project",
        workspaceRoot: directory,
        defaultModel: "gpt-5-codex",
        createdAt,
      });
      await dispatch({
        type: "thread.create",
        threadId,
        projectId,
        title: "Thread",
        model: "gpt-5-codex",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      await dispatch({
        type: "thread.turn.start",
        threadId,
        message: {
          messageId: MessageId.makeUnsafe("user"),
          role: "user",
          text: "work",
          attachments: [],
        },
        assistantDeliveryMode: "streaming",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt,
      });
      const session = {
        threadId,
        providerName: "codex" as const,
        providerInstanceId: instanceId,
        runtimeMode: "full-access" as const,
        lastError: null,
        updatedAt: createdAt,
      };
      await dispatch({
        type: "thread.session.set",
        threadId,
        session: { ...session, status: "running", activeTurnId: turnId },
        createdAt,
      });
      const record = (status: "running" | "completed") =>
        dispatch({
          type: "thread.command-execution.record",
          threadId,
          commandExecution: {
            id: commandExecutionId,
            turnId: mode === "turn-mismatch" ? TurnId.makeUnsafe("other-turn") : turnId,
            providerItemId: ProviderItemId.makeUnsafe("exec-1"),
            command: "ls",
            title: null,
            status,
            detail: null,
            exitCode: status === "completed" ? 0 : null,
            startedAt: createdAt,
            completedAt: status === "completed" ? createdAt : null,
            updatedAt: createdAt,
          },
          createdAt,
        });
      await record("running");
      await dispatch({
        type: "thread.command-execution.output.append",
        threadId,
        commandExecutionId,
        chunk: mode === "truncated-row" ? "x".repeat(300 * 1024) : streamed,
        updatedAt: createdAt,
        createdAt,
      });
      if (mode !== "running-row") await record("completed");
      if (mode !== "missing-tool-completed")
        await dispatch({
          type: "thread.activity.append",
          threadId,
          activity: {
            id: EventId.makeUnsafe("mcp-completed"),
            tone: "tool",
            kind: "tool.completed",
            summary: "Tool",
            payload: { itemType: "mcp_tool_call", providerItemId: "mcp-1", status: "completed" },
            turnId,
            createdAt,
          },
          createdAt,
        });
      await dispatch({
        type: "thread.message.assistant.delta",
        threadId,
        messageId: MessageId.makeUnsafe("assistant:native-item"),
        turnId,
        delta: " prefix",
        createdAt,
      });
      await dispatch({
        type: "thread.message.assistant.complete",
        threadId,
        messageId: MessageId.makeUnsafe("assistant:native-item"),
        turnId,
        createdAt,
      });
      await dispatch({
        type: "thread.session.set",
        threadId,
        session: {
          ...session,
          status: "ready",
          activeTurnId: null,
          lastError: "Provider output is incomplete.",
          lastErrorId: "incomplete:lost",
          lastErrorOccurredAt: createdAt,
        },
        createdAt,
      });
      const head0 = (await system.run(system.engine.getReadModel())).snapshotSequence;
      const reconcile = () =>
        system.run(
          reconcileCodexThreadSnapshots(
            {
              orchestrationEngine: engine,
              threadCommandExecutionQuery: system.threadCommandExecutionQuery,
              providerSessionDirectory: { getBinding: () => Effect.succeed(Option.some(binding)) },
              providerService: {
                readThread: () => Effect.succeed(snapshot),
                // The marker stays so a rerun re-verifies already repaired output.
                acknowledgeHistoryReconciliation: () =>
                  Effect.sync(() => {
                    acknowledgements++;
                    return true;
                  }),
              },
            },
            { threadIds: [threadId], reason: "overload", mode: "complete-or-extend", createdAt },
          ),
        );
      const readRow = async () =>
        (
          await system.run(
            system.threadCommandExecutionQuery.getThreadCommandExecution({
              threadId,
              commandExecutionId,
            }),
          )
        ).commandExecution;
      await reconcile();
      const state = await system.run(system.engine.getReadModel());
      const thread = state.threads.find((entry) => entry.id === threadId)!;
      const row = await readRow();
      const recovered = mode === "complete" || codexTruncated;
      expect(acknowledgements).toBe(recovered ? 1 : 0);
      if (recovered) {
        expect(row?.output).toBe(repairedOutput);
        expect(row?.outputTruncated).toBe(codexTruncated);
        expect(
          thread.messages.find((message) => message.id === "assistant:native-item")?.text,
        ).toBe(" prefix suffix");
        expect(thread.session?.lastError).toBeNull();
        expect(thread.session?.lastErrorId).toBeNull();
        await reconcile();
        expect(acknowledgements).toBe(2);
        expect((await system.run(system.engine.getReadModel())).snapshotSequence).toBe(
          state.snapshotSequence,
        );
        return;
      }
      expect(thread.session?.lastErrorId).toBe("incomplete:lost");
      if (mode === "stale-sequence") {
        expect(row?.output).toBe(`${streamed}late\n`);
        return;
      }
      expect(state.snapshotSequence).toBe(head0);
    } finally {
      await system.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  10_000,
);

it("plans command output repair only for a prefix of this exact command", () => {
  const row = {
    id: OrchestrationCommandExecutionId.makeUnsafe("cmdexec:thread:exec-1"),
    threadId: ThreadId.makeUnsafe("thread"),
    turnId: TurnId.makeUnsafe("turn"),
    providerItemId: ProviderItemId.makeUnsafe("exec-1"),
    command: "ls",
    title: null,
    status: "completed" as const,
    detail: null,
    output: "abc",
    outputTruncated: false,
    exitCode: 0,
    startedAt: "2026-11-08T00:00:00.000Z",
    completedAt: "2026-11-08T00:00:00.000Z",
    updatedAt: "2026-11-08T00:00:00.000Z",
    startedSequence: 1,
    lastUpdatedSequence: 7,
  };
  const item = { itemId: "exec-1", output: "abcdef" };
  expect(planCommandOutputRepair(row, item, "turn")).toMatchObject({
    expectedLastUpdatedSequence: 7,
    expected: { output: "abcdef", outputTruncated: false },
  });
  expect(planCommandOutputRepair({ ...row, output: "abcdef" }, item, "turn")).toBe("current");
  expect(planCommandOutputRepair({ ...row, output: "xyz" }, item, "turn")).toBeUndefined();
  expect(planCommandOutputRepair(row, item, "other-turn")).toBeUndefined();
  expect(planCommandOutputRepair({ ...row, status: "running" }, item, "turn")).toBeUndefined();
  expect(planCommandOutputRepair(null, item, "turn")).toBeUndefined();
  const marker = CODEX_PERSISTENCE_TRUNCATION_MARKER;
  // Codex's saved head is shorter than what F5 streamed: F5's text is kept, then the tail.
  const truncated = { itemId: "exec-1", output: `ab${marker}z` };
  expect(planCommandOutputRepair(row, truncated, "turn")).toMatchObject({
    expected: { output: `abc${marker}z`, outputTruncated: true },
  });
  expect(
    planCommandOutputRepair(
      { ...row, output: `abc${marker}z`, outputTruncated: true },
      truncated,
      "turn",
    ),
  ).toBe("current");
  // Codex's head extends F5's text: its copy is stored as saved.
  expect(
    planCommandOutputRepair(row, { itemId: "exec-1", output: `abcd${marker}z` }, "turn"),
  ).toMatchObject({ expected: { output: `abcd${marker}z`, outputTruncated: true } });
  expect(
    planCommandOutputRepair(row, { itemId: "exec-1", output: `xy${marker}z` }, "turn"),
  ).toBeUndefined();
  // Larger than the projection keeps: the event carries F5's capped copy, never more.
  const large = { itemId: "exec-1", output: `abc${"y".repeat(300 * 1024)}` };
  const repair = planCommandOutputRepair(row, large, "turn");
  expect(repair !== "current" && repair?.expected.outputTruncated).toBe(true);
  expect(
    repair !== "current" && Buffer.byteLength(repair?.expected.output ?? "") <= 256 * 1024,
  ).toBe(true);
});
