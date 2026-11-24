import { nativeTaskWorkItemId } from "@t3tools/shared/nativeTaskIdentity";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { isClaudeAgentTask } from "./provider/Layers/claudeTurnLifecycle.ts";
import {
  decodeFindings,
  parseWorkflowFindingOutput,
  type Finding,
} from "./orchestration/workflowFindingProtocol.ts";

export const workflowTurnKey = (threadId: string, turnId: string) =>
  JSON.stringify([threadId, turnId]);

interface SubagentTurn {
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly provider: string | null;
}

interface ActivityRow {
  readonly threadId: string;
  readonly turnId: string;
  readonly kind: string;
  readonly payload: string;
}

export interface BenchmarkSubagentEvidence {
  readonly id: string;
  readonly providerId: string;
  readonly label: string;
  readonly model: string | null;
  readonly status: string;
  readonly tokens: number | null;
  readonly costUsd: number | null;
  readonly findings: readonly Finding[];
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const asText = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const tokens = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const cost = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

function parseSubagentReport(value: unknown): readonly Finding[] {
  const report = asText(value);
  if (!report) return [];
  const parsed = parseWorkflowFindingOutput(report, "findings");
  return parsed.coverage === "structured" ? (parsed.metadata as readonly Finding[]) : [];
}

export function readBenchmarkSubagents(sql: SqlClient.SqlClient, turns: readonly SubagentTurn[]) {
  return Effect.gen(function* () {
    const parents = turns.filter(
      (turn) =>
        turn.threadId &&
        turn.turnId &&
        (turn.provider === "claudeAgent" || turn.provider === "codex"),
    );
    const result = new Map<string, readonly BenchmarkSubagentEvidence[]>();
    if (!parents.length) return result;

    const rows = yield* sql<ActivityRow>`
      SELECT a.thread_id AS threadId, a.turn_id AS turnId, a.kind, a.payload_json AS payload
      FROM json_each(${JSON.stringify(parents)}) AS parent
      JOIN projection_thread_activities a
        ON a.thread_id = json_extract(parent.value, '$.threadId')
        AND a.turn_id = json_extract(parent.value, '$.turnId')
      WHERE a.kind IN ('subagent.activity','task.started','task.progress','task.completed')
        AND ((a.kind = 'subagent.activity' AND json_extract(parent.value, '$.provider') = 'codex')
          OR (a.kind <> 'subagent.activity' AND json_extract(parent.value, '$.provider') = 'claudeAgent'))
      ORDER BY a.created_at, a.sequence, a.activity_id
    `;
    const byTurn = new Map<string, Map<string, BenchmarkSubagentEvidence>>();
    for (const row of rows) {
      const key = workflowTurnKey(row.threadId, row.turnId);
      const agents = byTurn.get(key) ?? new Map();
      byTurn.set(key, agents);
      const payload = record(JSON.parse(row.payload));
      const codex = row.kind === "subagent.activity";
      const providerId = asText(codex ? payload.subagentThreadId : payload.taskId);
      if (!providerId) continue;
      const id = codex ? providerId : nativeTaskWorkItemId(providerId, asText(payload.runId));
      const previous = agents.get(id);
      // Only a start on the exact parent turn can prove that a native task is a delegated agent.
      if (
        !codex &&
        !previous &&
        (row.kind !== "task.started" || !isClaudeAgentTask(asText(payload.taskType)))
      )
        continue;
      const terminal =
        row.kind === "task.completed" ||
        payload.subagentType === "completed" ||
        payload.subagentType === "interrupted";
      if (!terminal && previous && previous.status !== "running") continue;

      const usage = record(payload.usage);
      const status = terminal
        ? (asText(codex ? payload.subagentType : payload.status) ?? "completed")
        : "running";
      agents.set(id, {
        id,
        providerId,
        label:
          previous?.label ?? asText(codex ? payload.subagentPath : payload.detail) ?? providerId,
        model: asText(codex ? payload.subagentModel : payload.model) ?? previous?.model ?? null,
        status,
        // Native task reports are snapshots. Replace the sample instead of summing progress ticks.
        tokens: tokens(usage.total_tokens ?? usage.totalTokens) ?? previous?.tokens ?? null,
        costUsd: cost(usage.total_cost_usd ?? usage.totalCostUsd) ?? previous?.costUsd ?? null,
        findings:
          status === "completed"
            ? payload.subagentFindings
              ? decodeFindings(payload.subagentFindings)
              : parseSubagentReport(payload.detail)
            : [],
      });
    }
    for (const [key, agents] of byTurn) result.set(key, [...agents.values()]);
    return result;
  });
}
