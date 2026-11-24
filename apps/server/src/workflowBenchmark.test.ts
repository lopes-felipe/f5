import { assert, it } from "@effect/vitest";
import {
  CodeReviewWorkflow,
  CommandId,
  OrchestrationEvent,
  ProviderRuntimeEvent,
  ThreadId,
  TurnId,
  WorkflowBenchmarkResult,
  type WorkflowAttribution,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, test } from "vitest";
import { runMigrations } from "./persistence/Migrations.ts";
import * as SqliteClient from "./persistence/NodeSqliteClient.ts";
import {
  benchmarkDeliveryRows,
  getWorkflowBenchmark,
  type AttributedBenchmarkTurn,
} from "./workflowBenchmark.ts";
import { benchmarkFindings, type BenchmarkOutputRow } from "./workflowBenchmarkFindings.ts";
import { readBenchmarkSubagents, workflowTurnKey } from "./workflowBenchmarkSubagents.ts";
import { parseWorkflowFindingOutput } from "./orchestration/workflowFindingProtocol.ts";
import {
  captureWorkflowBenchmarkArtifact,
  materializeWorkflowBenchmark,
} from "./orchestration/workflowBenchmarkPersistence.ts";
import { createEmptyReadModel } from "./orchestration/projector.ts";
import { recordEffectiveTurnModel } from "./orchestration/workflowTurnModel.ts";
import {
  verifiesPatchCorrection,
  verifiesPlanCorrection,
  verifiesTargetedTest,
} from "./orchestration/workflowFindingEvidence.ts";
import { reviewFeedbackForPinnedTurn } from "./orchestration/workflowSharedUtils.ts";

const empty = "## Review\n\n" + ["~~~f5-findings-v1", "[]", "~~~"].join("\n");

test("requires changes at the reported location and a named test against the reviewed revision", () => {
  const finding = {
    id: "1",
    severity: "high",
    title: "Missing validation",
    description: "The boundary is unchecked.",
    location: "C:/repo/src/input.ts:42:3",
    evidence: "The expression return input; fails rejectsInvalidInput.",
  } as const;
  const correction = { before: "return input;", after: "return validate(input);" };
  const diff = [
    "diff --git a/src/input.ts b/src/input.ts",
    "--- a/src/input.ts",
    "+++ b/src/input.ts",
    "@@ -42 +42 @@",
    "-return input;",
    "+return validate(input);",
  ].join("\n");
  expect(verifiesPatchCorrection(finding, correction, diff, "C:/repo")).toBe(true);
  expect(verifiesPatchCorrection(finding, correction, diff.replaceAll("42", "43"), "C:/repo")).toBe(
    false,
  );
  expect(
    verifiesPatchCorrection(
      finding,
      correction,
      diff.replaceAll("input.ts", "other.ts"),
      "C:/repo",
    ),
  ).toBe(false);
  const documentFinding = { ...finding, location: "Validation" };
  const original = "## Validation\nreturn input;\n## Other\nNo changes";
  expect(
    verifiesPlanCorrection(
      documentFinding,
      correction,
      original,
      original.replace("return input;", "return validate(input);"),
    ),
  ).toBe(true);
  expect(
    verifiesPlanCorrection(
      documentFinding,
      correction,
      original,
      original + "\nreturn validate(input);",
    ),
  ).toBe(false);
  const target = { label: "Frozen checkout", headRevision: "123456" };
  expect(
    verifiesTargetedTest(
      "bun run test src/input.test.ts",
      "rejectsInvalidInput",
      "rejectsInvalidInput",
    ),
  ).toBe(false);
  expect(
    verifiesTargetedTest(
      "git rev-parse HEAD && vitest -t rejectsInvalidInput",
      "123456\nFAIL rejectsInvalidInput",
      "rejectsInvalidInput",
      target,
    ),
  ).toBe(true);
  expect(
    verifiesTargetedTest(
      "git rev-parse HEAD && vitest -t rejectsInvalidInput",
      "654321\nFAIL rejectsInvalidInput",
      "rejectsInvalidInput",
      target,
    ),
  ).toBe(false);
});

test("separates the terminal metadata and keeps quoted and nested examples in the report", () => {
  expect(parseWorkflowFindingOutput(empty, "findings")).toEqual({
    markdown: "## Review",
    coverage: "structured",
    metadata: [],
  });
  const quoted = empty
    .split("\n")
    .map((line) => "> " + line)
    .join("\n");
  const nested = ["~~~~md", empty, "~~~~"].join("\n");
  for (const markdown of [quoted, nested]) {
    expect(parseWorkflowFindingOutput(markdown, "findings")).toEqual({
      markdown,
      coverage: "unavailable",
      metadata: null,
    });
  }
  for (const markdown of [empty + "\n" + empty, empty.slice(0, -3), empty + "\nConclusion"]) {
    const result = parseWorkflowFindingOutput(markdown, "findings");
    expect(result.coverage).toBe("invalid");
    expect(result.markdown).toContain("## Review");
    expect(result.markdown).not.toContain("f5-findings-v1");
  }
  expect(
    parseWorkflowFindingOutput("<proposed_plan>\n" + empty + "\n</proposed_plan>", "findings"),
  ).toMatchObject({
    markdown: "<proposed_plan>\n## Review\n\n</proposed_plan>",
    coverage: "structured",
  });
});

const now = "2090-01-01T00:00:00.000Z";
const later = "2090-01-01T00:00:01.000Z";
const slot = { provider: "codex", model: "gpt-6.2-sol" };
const reviewer = (suffix: string) => ({
  label: suffix,
  threadId: "thread-" + suffix,
  slot,
  status: "completed",
  pinnedTurnId: "turn-" + suffix,
  pinnedAssistantMessageId: "message-" + suffix,
  error: null,
  updatedAt: now,
});
const run = Schema.decodeUnknownSync(CodeReviewWorkflow)({
  id: "run",
  projectId: "project",
  slug: "run",
  title: "Review",
  reviewPrompt: "Review",
  branch: null,
  reviewerA: reviewer("a"),
  reviewerB: reviewer("b"),
  consolidation: {
    slot,
    threadId: null,
    status: "not_started",
    pinnedTurnId: null,
    pinnedAssistantMessageId: null,
    error: null,
    updatedAt: now,
  },
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
});
const scope = { workflowId: run.id, runKind: "codeReview" } as const;

it.layer(SqliteClient.layerMemory())("benchmark subagent attribution", (it) => {
  it.effect("uses native task snapshots only for the matching parent turn and run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations;
      const activity = (
        id: string,
        turn: string,
        kind: string,
        payload: object,
        sequence: number,
      ) =>
        sql`INSERT INTO projection_thread_activities
          (activity_id, thread_id, turn_id, kind, tone, summary, payload_json, created_at, sequence)
          VALUES (${id}, 'claude-parent', ${turn}, ${kind}, 'info', 'Agent', ${JSON.stringify(payload)}, ${now}, ${sequence})`;
      const task = { taskId: "native-task", runId: "first-run" };
      yield* activity(
        "start",
        "first-turn",
        "task.started",
        {
          ...task,
          taskType: "local_agent",
          detail: "Explorer",
          model: "claude-haiku-4-5",
        },
        1,
      );
      yield* activity(
        "progress-1",
        "first-turn",
        "task.progress",
        {
          ...task,
          usage: { total_tokens: 100 },
        },
        2,
      );
      yield* activity(
        "progress-2",
        "first-turn",
        "task.progress",
        {
          ...task,
          usage: { total_tokens: 250 },
        },
        3,
      );
      yield* activity(
        "finish",
        "first-turn",
        "task.completed",
        {
          ...task,
          status: "completed",
          usage: { total_tokens: 300, total_cost_usd: 0 },
        },
        4,
      );
      yield* activity(
        "late-other-parent",
        "retry-turn",
        "task.progress",
        {
          ...task,
          usage: { total_tokens: 999 },
        },
        5,
      );
      yield* activity(
        "retry-start",
        "retry-turn",
        "task.started",
        {
          ...task,
          runId: "second-run",
          taskType: "local_agent",
          detail: "Retry explorer",
        },
        6,
      );
      yield* activity(
        "shell-start",
        "retry-turn",
        "task.started",
        {
          taskId: "shell",
          taskType: "local_bash",
          detail: "Unrelated shell",
        },
        7,
      );
      const agents = yield* readBenchmarkSubagents(
        sql,
        ["first-turn", "retry-turn"].map((turnId) => ({
          threadId: "claude-parent",
          turnId,
          provider: "claudeAgent",
        })),
      );
      assert.deepStrictEqual(agents.get(workflowTurnKey("claude-parent", "first-turn")), [
        {
          id: "native-task::run:first-run",
          providerId: "native-task",
          label: "Explorer",
          status: "completed",
          model: "claude-haiku-4-5",
          tokens: 300,
          costUsd: 0,
          findings: [],
        },
      ]);
      assert.deepStrictEqual(
        agents
          .get(workflowTurnKey("claude-parent", "retry-turn"))
          ?.map((agent) => [agent.id, agent.tokens]),
        [["native-task::run:second-run", null]],
      );
    }),
  );
});

test("groups only a proven shared target and restores surviving decisions after rewind", () => {
  const refs = ["thread-a/turn-a/1", "thread-b/turn-b/1", "thread-c/turn-c/1"];
  const report = (
    id: string,
    taskId: string,
    model: string,
    headRevision?: string,
  ): AttributedBenchmarkTurn => ({
    phase: taskId === "consolidation" ? "consolidation" : "reviews",
    attribution: {
      ...scope,
      taskId,
      originCommandId: CommandId.make(id),
      ...(headRevision
        ? { reviewTarget: { label: "feature", baseRevision: "base", headRevision } }
        : { findingRefs: refs.slice(0, 2) }),
    },
    turn: {
      id,
      threadId: ThreadId.make("thread-" + id),
      turnId: TurnId.make("turn-" + id),
      threadTitle: null,
      model: { id: model, label: model },
      modelSource: "effective",
      attempt: 1,
      durationMs: 10,
      role: "Reviewer",
      status: "completed",
      target: null,
      aggregateRerouteUsage: false,
      usage: {
        tokens: 0,
        costUsd: 0,
        estimated: false,
        missingCost: 0,
        missingTokens: 0,
        pending: 0,
      },
    },
  });
  const turns = [
    report("a", "reviewer-a", "Codex", "head"),
    report("b", "reviewer-b", "Codex", "head"),
    report("c", "reviewer-a", "Codex", "different-head"),
    report("d", "consolidation", "Codex"),
  ];
  const outputs: BenchmarkOutputRow[] = turns.map(({ turn, attribution }, index) => ({
    threadId: turn.threadId!,
    turnId: turn.turnId!,
    taskId: attribution.taskId,
    coverage: "structured",
    messageId: "message-" + turn.id,
    planId: null,
    kind: index === 3 ? "dispositions" : "findings",
    metadata: JSON.stringify(
      index === 3
        ? [
            {
              ref: refs[0],
              verdict: "confirmed",
              equivalentTo: [refs[1], refs[2]],
              testExecutionId: "unverified",
            },
            { ref: refs[1], verdict: "dismissed" },
            { ref: refs[2], verdict: "dismissed" },
          ]
        : [
            {
              id: "1",
              severity: index === 1 ? "high" : "medium",
              title: "Unexpected data at boundary",
              description: "Boundary logic returns the wrong row",
              location: "src/file.ts:42",
              evidence: "Input ended on a page boundary",
              ...(index < 2
                ? { subagentFinding: { agentId: "explorer", findingId: "child" } }
                : {}),
            },
          ],
    ),
  }));
  const results = benchmarkFindings(
    turns,
    outputs,
    new Map([
      [
        workflowTurnKey("thread-a", "turn-a"),
        [
          {
            id: "explorer",
            providerId: "explorer",
            label: "Explorer",
            model: null,
            status: "completed",
            tokens: null,
            costUsd: null,
            findings: [
              {
                id: "child",
                severity: "medium",
                title: "Unexpected data at boundary",
                description: "Reproduced",
                location: "src/file.ts:42",
                evidence: "Child evidence",
              },
            ],
          },
        ],
      ],
    ]),
  );
  expect(results.total).toBe(2);
  const matches = results.page({
    kind: "findings",
    phase: "reviews",
    model: "Codex",
    reviewer: "reviewer-b",
    reviewTurn: { threadId: ThreadId.make("thread-b"), turnId: TurnId.make("turn-b") },
    severity: "high",
    status: "confirmed",
    search: "page boundary",
  });
  expect(matches.counts).toMatchObject({ confirmed: 1, checking: 0, shared: 1, dismissed: 0 });
  expect(matches.items[0]?.reporters.map(({ reviewer }) => reviewer?.id)).toEqual([
    "reviewer-a",
    "reviewer-b",
  ]);
  expect(matches.items[0]?.reporters.map(({ discoveredBy }) => discoveredBy?.label)).toEqual([
    "Explorer",
    undefined,
  ]);
  expect(results.turnCount(ThreadId.make("thread-a"), TurnId.make("turn-a"))?.count).toBe(1);
  expect(results.turnCount(ThreadId.make("thread-b"), TurnId.make("turn-b"))?.count).toBe(1);
  expect(matches.items).toMatchObject([
    { id: refs[0], aliases: [refs[1]], severity: "high", test: "reported" },
  ]);
  turns[3]!.turn = { ...turns[3]!.turn, status: "Reverted" };
  expect(
    benchmarkFindings(turns, outputs).page({ kind: "findings", phase: "reviews" }).counts,
  ).toMatchObject({ confirmed: 0, checking: 2 });
});

it.layer(SqliteClient.layerMemory())("workflow benchmark", (it) => {
  it.effect(
    "captures clean Markdown before late acceptance and indexes the exact artifact used at handoff",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations;
        const {
          threadId,
          pinnedTurnId: turnId,
          pinnedAssistantMessageId: messageId,
        } = run.reviewerA;
        const workflowAttribution = {
          ...scope,
          taskId: "reviewer-a",
          originCommandId: "dispatch-a",
          reviewTarget: {
            label: "Checkout",
            baseRevision: "base-commit",
            headRevision: "head-commit",
          },
        };
        const eventJson = JSON.stringify({
          type: "thread.turn-start-requested",
          payload: { workflowAttribution },
        });
        yield* sql`INSERT INTO provider_turn_deliveries
        (delivery_id, thread_id, command_id, message_id, state, attempt_id, event_json, created_at, updated_at)
        VALUES ('dispatch-a', ${threadId}, 'dispatch-a', 'request-a', 'sending', 'attempt-a', ${eventJson}, ${now}, ${now})`;
        yield* sql`INSERT INTO projection_turns
        (thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at, started_at, completed_at, processing_quiesced_at, checkpoint_files_json)
        VALUES (${threadId}, ${turnId}, 'request-a', ${messageId}, 'completed', ${now}, ${now}, ${later}, ${later}, '[]')`;
        const event = Schema.decodeUnknownSync(OrchestrationEvent)({
          sequence: 1,
          streamVersion: 1,
          eventId: "reply",
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: later,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          actorKind: "provider",
          metadata: {},
          type: "thread.message-sent",
          payload: {
            threadId,
            turnId,
            messageId,
            role: "assistant",
            text: empty,
            streaming: false,
            createdAt: now,
            updatedAt: later,
          },
        });
        assert.strictEqual(event.type, "thread.message-sent");
        if (event.type !== "thread.message-sent") return;
        const clean = yield* captureWorkflowBenchmarkArtifact(
          sql,
          event,
          createEmptyReadModel(now),
        );
        if (clean.type !== "thread.message-sent") return assert.fail("expected assistant reply");
        assert.strictEqual(clean.payload.text, "## Review");
        yield* sql`UPDATE projection_turns SET pending_message_id = NULL
          WHERE thread_id = ${threadId} AND turn_id = ${turnId}`;
        const recovered = yield* captureWorkflowBenchmarkArtifact(sql, event, {
          ...createEmptyReadModel(now),
          codeReviewWorkflows: [run],
        });
        if (recovered.type !== "thread.message-sent")
          return assert.fail("expected assistant reply");
        assert.strictEqual(recovered.payload.text, "## Review");
        yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
          VALUES (${messageId}, ${threadId}, ${turnId}, 'assistant', ${clean.payload.text}, 0, ${now}, ${later})`;
        const report =
          "## Longer review provided as a plan\n\nThe provider returned the complete report here.";
        const planMarkdown =
          report +
          "\n\n~~~f5-findings-v1\n" +
          JSON.stringify([
            {
              id: "plan",
              title: "From the chosen plan",
              description: "Evidence belongs to the plan.",
              severity: "high",
              location: null,
              evidence: "rejectsInvalidInput reproduces the reported failure.",
            },
          ]) +
          "\n~~~";
        yield* sql`INSERT INTO projection_thread_proposed_plans
        (plan_id, thread_id, turn_id, plan_markdown, created_at, updated_at)
        VALUES ('chosen-plan', ${threadId}, ${turnId}, ${planMarkdown}, ${now}, ${later})`;
        assert.strictEqual(
          reviewFeedbackForPinnedTurn(
            {
              latestTurn: { assistantMessageId: messageId },
              messages: [
                {
                  id: messageId!,
                  role: "assistant",
                  streaming: false,
                  turnId,
                  text: clean.payload.text,
                },
              ],
              proposedPlans: [{ turnId, planMarkdown }],
            },
            turnId,
            messageId,
          )?.text,
          report,
        );
        yield* materializeWorkflowBenchmark(sql, run, later);
        const before = yield* sql`SELECT * FROM workflow_benchmark_outputs`;
        assert.lengthOf(before, 0);
        yield* sql`UPDATE provider_turn_deliveries SET state = 'accepted', provider_turn_id = ${turnId} WHERE delivery_id = 'dispatch-a'`;
        yield* materializeWorkflowBenchmark(sql, run, later);
        yield* materializeWorkflowBenchmark(sql, run, later);
        const after = yield* sql<{ coverage: string; metadata: string; planId: string }>`
          SELECT coverage, metadata_json AS metadata, plan_id AS planId FROM workflow_benchmark_outputs`;
        assert.lengthOf(after, 1);
        assert.strictEqual(after[0]?.coverage, "structured");
        assert.strictEqual(after[0]?.planId, "chosen-plan");
        assert.include(after[0]?.metadata ?? "", "From the chosen plan");

        const updatedRun = Schema.decodeUnknownSync(CodeReviewWorkflow)({
          ...run,
          consolidation: {
            ...run.consolidation,
            threadId: ThreadId.make("consolidation-thread"),
            status: "completed",
            pinnedTurnId: TurnId.make("consolidation-turn"),
            pinnedAssistantMessageId: "consolidation-message",
          },
        });
        const { consolidation } = updatedRun;
        const ref = [threadId, turnId, "plan"].join("/");
        const consolidationEvent = JSON.stringify({
          type: "thread.turn-start-requested",
          payload: {
            workflowAttribution: {
              ...scope,
              taskId: "consolidation",
              originCommandId: "dispatch-consolidation",
              findingRefs: [ref],
            },
          },
        });
        yield* sql`INSERT INTO provider_turn_deliveries
          (delivery_id, thread_id, command_id, message_id, state, provider_turn_id, event_json, created_at, updated_at)
          VALUES ('dispatch-consolidation', ${consolidation.threadId}, 'dispatch-consolidation',
            'consolidation-request', 'accepted', ${consolidation.pinnedTurnId}, ${consolidationEvent}, ${later}, ${later})`;
        yield* sql`INSERT INTO projection_thread_command_executions
          (command_execution_id, thread_id, turn_id, command, cwd, status, output, output_truncated,
            exit_code, started_sequence, last_updated_sequence, started_at, completed_at, updated_at)
          VALUES ('targeted-reproduction', ${threadId}, ${turnId}, 'git rev-parse HEAD && vitest -t rejectsInvalidInput',
            'C:/repo', 'failed', ${"head-commit\nFAIL rejectsInvalidInput"}, 0, 1, 1, 1, ${now}, ${later}, ${later})`;
        yield* sql`INSERT INTO projection_turns
          (thread_id, turn_id, state, requested_at, started_at, completed_at, checkpoint_files_json)
          VALUES (${consolidation.threadId}, ${consolidation.pinnedTurnId}, 'completed', ${now}, ${now}, ${later}, '[]')`;
        const dispositionText =
          "## Final review\n\n~~~f5-finding-dispositions-v1\n" +
          JSON.stringify([
            {
              ref,
              verdict: "confirmed",
              resolution: "fixed",
              evidence: "Claimed correction",
              testExecutionId: "targeted-reproduction",
              testCase: "rejectsInvalidInput",
            },
          ]) +
          "\n~~~";
        yield* sql`INSERT INTO projection_thread_messages
          (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
          VALUES (${consolidation.pinnedAssistantMessageId}, ${consolidation.threadId}, ${consolidation.pinnedTurnId},
            'assistant', ${dispositionText}, 0, ${later}, ${later})`;
        for (const id of [threadId, consolidation.threadId]) {
          yield* sql`INSERT INTO projection_threads
            (thread_id, project_id, title, model, created_at, last_interaction_at, updated_at)
            VALUES (${id}, 'project', 'Review', 'thread-model', ${now}, ${now}, ${now})`;
        }
        yield* materializeWorkflowBenchmark(sql, updatedRun, later);
        const findings = yield* getWorkflowBenchmark(
          sql,
          { ...scope, select: { kind: "findings", phase: "reviews" } },
          updatedRun,
          { usageModelAliases: {}, usagePriceOverrides: [] },
        );
        if (findings.kind !== "findings") return assert.fail("expected findings");
        assert.strictEqual(findings.items[0]?.status, "confirmed");
        assert.strictEqual(findings.items[0]?.test, "confirmed");
        assert.strictEqual(findings.items[0]?.testEvidence?.origin.threadId, threadId);
        assert.isNull(findings.items[0]?.resolution);
      }),
  );
});

it.layer(SqliteClient.layerMemory())("workflow benchmark usage", (it) => {
  it.effect(
    "counts accepted usage once, excludes manual and ambiguous turns, and reads from the run index",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations;
        for (const suffix of ["a", "b"] as const) {
          yield* sql`
          INSERT INTO projection_threads (thread_id, project_id, title, model, created_at, last_interaction_at, updated_at)
          VALUES (${"thread-" + suffix}, 'project', 'Review', 'thread-model', ${now}, ${now}, ${now})
        `;
        }
        const delivery = (
          id: string,
          task: "a" | "b",
          turnId: string,
          origin: string | null,
          type = "thread.turn-start-requested",
          createdAt = now,
        ) => {
          const workflowAttribution = origin
            ? {
                ...scope,
                taskId: "reviewer-" + task,
                originCommandId: origin as WorkflowAttribution["originCommandId"],
              }
            : undefined;
          const eventJson = JSON.stringify({
            type,
            payload: { workflowAttribution, provider: "codex", model: slot.model },
          });
          return sql`
          INSERT INTO provider_turn_deliveries
            (delivery_id, thread_id, command_id, message_id, state, provider_turn_id, event_json, created_at, updated_at)
          VALUES (${id}, ${"thread-" + task}, ${id}, ${"msg-" + id}, 'accepted',
            ${turnId}, ${eventJson}, ${createdAt}, ${createdAt})
        `;
        };
        const fact = (task: "a" | "b", turnId: string, total: number, cost: number | null) => sql`
        INSERT INTO projection_turn_usage_facts
          (turn_id, thread_id, project_id, provider_name, model, input_tokens, output_tokens, cache_read_tokens,
            total_tokens, provider_cost_usd, token_provenance, cost_provenance, completed_at, recorded_at, source_event_id)
        VALUES (${turnId}, ${"thread-" + task}, 'project', 'codex', 'gpt-6.2-sol', 90, 10, 30,
          ${total}, ${cost}, 'provider-reported', ${cost === null ? "unreported" : "provider-reported"}, ${later}, ${later}, ${"event-" + turnId})
      `;
        yield* delivery("dispatch-a", "a", "turn-a", "dispatch-a");
        yield* delivery("steer-a", "a", "turn-a", null, "thread.turn-steer-requested");
        yield* delivery("continuation-a", "a", "continued", "dispatch-a", undefined, later);
        yield* delivery("retry-a", "a", "retry-turn", "retry-a", undefined, later);
        yield* delivery("manual", "a", "manual-turn", null);
        yield* delivery("dispatch-b", "b", "turn-b", "dispatch-b");
        yield* delivery("conflicting-manual", "b", "turn-b", null);
        yield* fact("a", "turn-a", 100, 0);
        yield* fact("a", "continued", 100, null);
        yield* fact("a", "retry-turn", 0, 0);
        yield* fact("a", "manual-turn", 1_000, 5);
        yield* fact("b", "turn-b", 1_000, 5);
        yield* sql`INSERT INTO projection_thread_activities
          (activity_id, thread_id, turn_id, kind, tone, summary, payload_json, created_at)
          VALUES ('codex-child', 'thread-a', 'turn-a', 'subagent.activity', 'tool', 'Subagent',
            '{"subagentThreadId":"child","subagentPath":"Explorer","subagentType":"completed","subagentModel":"gpt-6.2-sol"}',
            ${now})`;
        yield* sql`UPDATE provider_turn_deliveries SET benchmark_reverted_at = ${later} WHERE delivery_id = 'retry-a'`;
        const settings = {
          usageModelAliases: { "gpt-6.2-sol": "pricing-model" },
          usagePriceOverrides: [
            {
              provider: "codex" as const,
              model: "pricing-model",
              inputUsdPerMillion: 1,
              outputUsdPerMillion: 2,
              cacheReadUsdPerMillion: 0,
              cacheWriteUsdPerMillion: null,
            },
          ],
        };
        const result = yield* getWorkflowBenchmark(
          sql,
          { ...scope, select: { kind: "summary" } },
          run,
          settings,
        );
        assert.isDefined(Schema.decodeUnknownSync(WorkflowBenchmarkResult)(result));
        assert.strictEqual(result.kind, "summary");
        if (result.kind !== "summary") return;
        assert.strictEqual(result.total.tokens, 200);
        assert.strictEqual(result.total.costUsd, 80 / 1_000_000);
        assert.isTrue(result.total.estimated);
        assert.strictEqual(result.total.estimatedCodexCredits, 5_575 / 1_000_000);
        assert.strictEqual(result.ambiguous, 1);
        assert.strictEqual(result.models.length, 1);
        const turns = yield* getWorkflowBenchmark(
          sql,
          { ...scope, select: { kind: "turns", phase: "reviews" } },
          run,
          settings,
        );
        if (turns.kind !== "turns") return assert.fail("expected turns");
        assert.deepStrictEqual<ReadonlyArray<readonly [string | null, number]>>(
          turns.items.map(({ turnId, attempt }) => [turnId, attempt]),
          [
            ["turn-a", 1],
            ["continued", 1],
            ["retry-turn", 2],
          ],
        );
        assert.strictEqual(turns.items[2]?.status, "Reverted");
        assert.strictEqual(turns.items[0]?.tokenScope, "unknown");
        assert.strictEqual(turns.items[0]?.usage.tokens, 100);
        assert.isUndefined(turns.items[0]?.usage.estimatedCodexCredits);
        assert.strictEqual(turns.items[1]?.usage.estimatedCodexCredits, 5_575 / 1_000_000);
        assert.strictEqual(turns.items[0]?.subagents?.[0]?.label, "Explorer");
        assert.isNull(turns.items[0]?.subagents?.[0]?.tokens);
        assert.isUndefined(turns.items[1]?.subagents);
        const reroute = Schema.decodeUnknownSync(ProviderRuntimeEvent)({
          type: "model.rerouted",
          threadId: "thread-a",
          turnId: "turn-a",
          eventId: "reroute-review",
          provider: "codex",
          createdAt: later,
          payload: {
            fromModel: "gpt-6.2-sol",
            toModel: "gpt-6.2-astra",
            reason: "Provider fallback",
          },
        });
        assert.isTrue(yield* recordEffectiveTurnModel(sql, reroute));
        const [factAfterReroute] =
          yield* sql`SELECT model FROM projection_turn_usage_facts WHERE turn_id = 'turn-a'`;
        assert.deepStrictEqual(factAfterReroute, { model: "gpt-6.2-sol" });
        const rerouted = yield* getWorkflowBenchmark(
          sql,
          { ...scope, select: { kind: "turns", phase: "reviews" } },
          run,
          settings,
        );
        if (rerouted.kind !== "turns") return assert.fail("expected turn page");
        assert.strictEqual(rerouted.items[0]?.modelSource, "effective");
        assert.strictEqual(rerouted.items[0]?.model.id, "gpt-6.2-astra");

        yield* sql`
          WITH RECURSIVE samples(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM samples WHERE n < 200)
          INSERT INTO provider_turn_deliveries
            (delivery_id, thread_id, command_id, message_id, state, event_json, created_at, updated_at)
          SELECT 'sample-' || n, 'thread-a', 'sample-' || n, 'request-' || n, 'rejected',
            json_object('type', 'thread.turn-start-requested', 'payload', json_object('workflowAttribution',
              json_object('runKind','codeReview','workflowId',${run.id},'taskId','reviewer-a','originCommandId','sample-' || n))),
            ${later}, ${later}
          FROM samples
        `;
        const running = { ...run, reviewerA: { ...run.reviewerA, status: "running" as const } };
        const page = yield* getWorkflowBenchmark(
          sql,
          { ...scope, select: { kind: "turns", phase: "reviews", offset: 200 } },
          running,
          settings,
        );
        if (page.kind !== "turns") return assert.fail("expected turn page");
        assert.strictEqual(page.count, 204);
        assert.deepStrictEqual(
          page.items.map(({ attempt, status }) => [attempt, status]),
          [
            [200, "rejected"],
            [201, "rejected"],
            [202, "rejected"],
            [203, "pending"],
          ],
        );
        const beyond = yield* getWorkflowBenchmark(
          sql,
          { ...scope, select: { kind: "turns", phase: "reviews", offset: 204 } },
          running,
          settings,
        );
        assert.deepStrictEqual(beyond, { kind: "turns", items: [], count: 204 });
        const [statement, params] = benchmarkDeliveryRows(sql, scope, run.projectId, [], {
          taskIds: ["reviewer-a", "reviewer-b"],
          pageOffset: 200,
        }).compile();
        const plan = yield* sql.unsafe<{ detail: string }>(
          "EXPLAIN QUERY PLAN " + statement,
          params,
        );
        assert.isTrue(
          plan.some(({ detail }) =>
            detail.includes("SEARCH d USING INDEX idx_delivery_workflow_benchmark"),
          ),
        );
      }),
  );
});
