import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationCommandExecutionId,
  type OrchestrationEvent,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "../orchestration/Services/ProjectionPipeline.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import {
  compactCommandOutputCopy,
  COMPACTED_COMMAND_OUTPUT_MAX_BYTES,
  compactThreadEvents,
  foldMessagePayloads,
} from "./eventCompaction.ts";

const layer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "f5-event-compaction-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const at = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.makeUnsafe("compaction-project");
const threadId = ThreadId.makeUnsafe("compaction-thread");
const turnId = TurnId.makeUnsafe("compaction-turn");
const commandExecutionId = OrchestrationCommandExecutionId.makeUnsafe("compaction-command");
const streamedMessageId = MessageId.makeUnsafe("streamed-message");
const openMessageId = MessageId.makeUnsafe("open-message");

let counter = 0;
const base = () => {
  counter += 1;
  return {
    eventId: EventId.makeUnsafe(`compaction-event-${counter}`),
    occurredAt: at,
    commandId: CommandId.makeUnsafe(`provider:compaction-${counter}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
  };
};

const threadEvent = (event: {
  readonly type: OrchestrationEvent["type"];
  readonly payload: unknown;
}) =>
  ({
    ...base(),
    aggregateKind: "thread",
    aggregateId: threadId,
    ...event,
  }) as Omit<OrchestrationEvent, "sequence">;

const commandRecord = (completedAt: string | null) => ({
  id: commandExecutionId,
  turnId,
  providerItemId: null,
  command: "bun run test",
  title: null,
  status: completedAt === null ? "running" : "completed",
  detail: null,
  exitCode: completedAt === null ? null : 0,
  startedAt: at,
  completedAt,
  updatedAt: at,
});

const message = (input: {
  readonly messageId: MessageId;
  readonly text: string;
  readonly streaming: boolean;
  readonly createdAt?: string;
}) => ({
  threadId,
  messageId: input.messageId,
  role: "assistant",
  text: input.text,
  turnId,
  streaming: input.streaming,
  createdAt: input.createdAt ?? at,
  updatedAt: at,
});

const outputChunk = (letter: string) => letter.repeat(12 * 1024);

const seed = Effect.gen(function* () {
  const store = yield* OrchestrationEventStore;
  const sql = yield* SqlClient.SqlClient;
  const events: Array<Omit<OrchestrationEvent, "sequence">> = [
    {
      ...base(),
      aggregateKind: "project",
      aggregateId: projectId,
      type: "project.created",
      payload: {
        projectId,
        title: "Compaction",
        workspaceRoot: "/tmp/compaction",
        defaultModel: null,
        scripts: [],
        createdAt: at,
        updatedAt: at,
      },
    } as Omit<OrchestrationEvent, "sequence">,
    threadEvent({
      type: "thread.created",
      payload: {
        threadId,
        projectId,
        title: "Compaction",
        model: "gpt-5-codex",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: at,
        updatedAt: at,
      },
    }),
    threadEvent({
      type: "thread.command-execution-recorded",
      payload: { threadId, commandExecution: commandRecord(null) },
    }),
    ...["a", "b", "c"].map((letter) =>
      threadEvent({
        type: "thread.command-execution-output-appended",
        payload: { threadId, commandExecutionId, chunk: outputChunk(letter), updatedAt: at },
      }),
    ),
    threadEvent({
      type: "thread.command-execution-recorded",
      payload: { threadId, commandExecution: commandRecord(at) },
    }),
    ...["Hel", "lo ", "world"].map((text, index) =>
      threadEvent({
        type: "thread.message-sent",
        payload: message({
          messageId: streamedMessageId,
          text,
          streaming: true,
          createdAt: index === 0 ? at : "2026-01-01T00:00:01.000Z",
        }),
      }),
    ),
    threadEvent({
      type: "thread.message-sent",
      payload: message({ messageId: streamedMessageId, text: "", streaming: false }),
    }),
    ...["still ", "going"].map((text) =>
      threadEvent({
        type: "thread.message-sent",
        payload: message({ messageId: openMessageId, text, streaming: true }),
      }),
    ),
  ];
  for (const event of events) {
    const stored = yield* store.append(event);
    yield* sql`
      INSERT INTO orchestration_command_receipts (
        command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error
      ) VALUES (
        ${stored.commandId}, ${stored.aggregateKind}, ${stored.aggregateId}, ${at},
        ${stored.sequence}, 'accepted', NULL
      )
    `;
  }
  yield* (yield* OrchestrationProjectionPipeline).bootstrap;
});

const eventCount = (type: OrchestrationEvent["type"]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_events WHERE event_type = ${type}
    `;
    return rows[0]?.count ?? 0;
  });

const projectedState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const messages = yield* sql<{
    readonly messageId: string;
    readonly text: string;
    readonly isStreaming: number;
    readonly createdAt: string;
  }>`
    SELECT message_id AS "messageId", text, is_streaming AS "isStreaming", created_at AS "createdAt"
    FROM projection_thread_messages ORDER BY message_id
  `;
  const commands = yield* sql<{ readonly output: string; readonly outputTruncated: number }>`
    SELECT output, output_truncated AS "outputTruncated"
    FROM projection_thread_command_executions
  `;
  return { messages, commands };
});

describe("foldMessagePayloads", () => {
  it("folds streamed deltas into one final payload, as the projections do", () => {
    const payload = (text: string, streaming: boolean, reasoningText?: string) => ({
      text,
      streaming,
      createdAt: text.length > 0 ? `t-${text}` : "t-final",
      ...(reasoningText !== undefined ? { reasoningText } : {}),
    });
    assert.deepStrictEqual(
      foldMessagePayloads([
        payload("Hel", true, "th"),
        payload("lo", true, "ink"),
        payload("", false, ""),
      ]),
      { text: "Hello", reasoningText: "think", streaming: false, createdAt: "t-Hel" },
    );
    // A non-empty final payload replaces what streamed before it.
    assert.deepStrictEqual(foldMessagePayloads([payload("draft", true), payload("Final", false)]), {
      text: "Final",
      streaming: false,
      createdAt: "t-draft",
    });
  });

  it("keeps small command output whole and cuts large output to a head and tail", () => {
    assert.deepStrictEqual(compactCommandOutputCopy("ok\n"), { chunk: "ok\n", truncated: false });
    const large = compactCommandOutputCopy(`${"h".repeat(40_000)}${"t".repeat(40_000)}`);
    assert.isTrue(large.truncated);
    assert.isAtMost(Buffer.byteLength(large.chunk), COMPACTED_COMMAND_OUTPUT_MAX_BYTES);
    assert.include(large.chunk, "80000 bytes in total");
    assert.isTrue(large.chunk.startsWith("h") && large.chunk.endsWith("t"));
  });
});

it.layer(layer)("compactThreadEvents", (it) => {
  it.effect("compacts finished output and messages, and replays to the same projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      const before = yield* projectedState;
      const receiptsBefore = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_command_receipts
      `;

      const result = yield* compactThreadEvents({ nowMs: Date.now(), maxDurationMs: 60_000 });
      assert.deepInclude(result, {
        threadsCompacted: 1,
        commandOutputsCompacted: 1,
        messagesCompacted: 1,
        eventsRemoved: 5,
        receiptsRemoved: 5,
        complete: true,
      });
      assert.equal(yield* eventCount("thread.command-execution-output-appended"), 1);
      // The finished message collapses; the one still streaming is untouched.
      assert.equal(yield* eventCount("thread.message-sent"), 3);
      const receiptsAfter = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_command_receipts
      `;
      assert.equal(receiptsAfter[0]!.count, receiptsBefore[0]!.count - 5);

      const output = yield* sql<{ readonly payloadJson: string }>`
        SELECT payload_json AS "payloadJson" FROM orchestration_events
        WHERE event_type = 'thread.command-execution-output-appended'
      `;
      const compacted = JSON.parse(output[0]!.payloadJson) as {
        chunk: string;
        outputTruncated?: boolean;
      };
      assert.equal(compacted.chunk, compactCommandOutputCopy(before.commands[0]!.output).chunk);
      assert.isTrue(compacted.outputTruncated);

      // Projections are untouched, and a rebuild from the compacted log gives
      // the same messages and the compacted command output.
      assert.deepStrictEqual(yield* projectedState, before);
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_command_executions`;
      yield* sql`
        DELETE FROM projection_state
        WHERE projector IN ('projection.thread-messages', 'projection.thread-command-executions')
      `;
      yield* (yield* OrchestrationProjectionPipeline).bootstrap;
      const rebuilt = yield* projectedState;
      assert.deepStrictEqual(rebuilt.messages, before.messages);
      assert.deepStrictEqual(rebuilt.commands, [{ output: compacted.chunk, outputTruncated: 1 }]);
      assert.equal(
        before.messages.find((row) => row.messageId === streamedMessageId)?.text,
        "Hello world",
      );

      // Nothing new: the watermark skips the thread, and a forced revisit is a no-op.
      const again = yield* compactThreadEvents({ nowMs: Date.now(), maxDurationMs: 60_000 });
      assert.equal(again.threadsCompacted, 0);
      yield* sql`DELETE FROM orchestration_event_compaction`;
      const revisit = yield* compactThreadEvents({ nowMs: Date.now(), maxDurationMs: 60_000 });
      assert.deepInclude(revisit, { threadsCompacted: 1, eventsRemoved: 0 });
    }),
  );

  it.effect("leaves threads alone until every projector has applied their events", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM orchestration_events`;
      yield* sql`DELETE FROM orchestration_event_compaction`;
      yield* sql`DELETE FROM projection_threads`;
      yield* seed;
      yield* sql`
        UPDATE projection_state SET last_applied_sequence = 1
        WHERE projector = 'projection.thread-activities'
      `;
      const result = yield* compactThreadEvents({ nowMs: Date.now(), maxDurationMs: 60_000 });
      assert.deepInclude(result, { threadsCompacted: 0, eventsRemoved: 0 });
    }),
  );

  it.effect("skips threads used within the last hour", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM orchestration_events`;
      yield* sql`DELETE FROM orchestration_event_compaction`;
      yield* sql`DELETE FROM projection_threads`;
      yield* seed;
      const result = yield* compactThreadEvents({
        nowMs: Date.parse(at) + 30 * 60 * 1_000,
        maxDurationMs: 60_000,
      });
      assert.equal(result.threadsCompacted, 0);
    }),
  );
});
