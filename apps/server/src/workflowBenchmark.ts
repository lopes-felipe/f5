import {
  isKnownProviderKind,
  ThreadId,
  TurnId,
  type UsagePriceOverride,
  type WorkflowAttribution,
  type WorkflowBenchmarkInput,
  type WorkflowBenchmarkPhase,
  type WorkflowBenchmarkResult,
  type WorkflowBenchmarkTurn,
  type WorkflowBenchmarkUsage,
} from "@t3tools/contracts";
import { formatModelDisplayName, getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  BENCHMARK_PHASES,
  benchmarkOutputKind,
  benchmarkPhase,
  benchmarkPhases,
  benchmarkRole,
  benchmarkTasks,
  type BenchmarkTask,
  type BenchmarkWorkflow,
} from "./orchestration/workflowBenchmarkTasks.ts";
import { readAttribution } from "./orchestration/workflowBenchmarkPersistence.ts";
import { applyPriceOverride, resolveModelAliases } from "./usage/usageSummary.ts";
import { estimateCodexStandardCredits } from "./usage/codexCreditEstimate.ts";
import type { UsageAggregateRow } from "./persistence/Services/UsageFacts.ts";
import { benchmarkFindings, type BenchmarkOutputRow } from "./workflowBenchmarkFindings.ts";
import {
  readBenchmarkSubagents,
  workflowTurnKey,
  type BenchmarkSubagentEvidence,
} from "./workflowBenchmarkSubagents.ts";

interface TurnRow {
  readonly id: string;
  readonly threadId: string;
  readonly title: string | null;
  readonly turnId: string | null;
  readonly state: string;
  readonly attribution: string | null;
  readonly provider: string | null;
  readonly configuredModel: string | null;
  readonly factId: string | null;
  readonly factModel: string | null;
  readonly factProvider: string | null;
  readonly effectiveModel: string | null;
  readonly rerouted: number | null;
  readonly recordedAt: string | null;
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly tokens: number | null;
  readonly cost: number | null;
  readonly turnState: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly revertedAt: string | null;
  readonly conflicting: number;
  readonly pausedContinuation: number;
  readonly attemptNumber: number | null;
  readonly pageCount: number | null;
  readonly pageAttempts: string | null;
}

export function benchmarkDeliveryRows(
  sql: SqlClient.SqlClient,
  input: Pick<WorkflowBenchmarkInput, "runKind" | "workflowId">,
  projectId: string,
  legacyTasks: ReadonlyArray<BenchmarkTask>,
  options: {
    readonly taskIds?: ReadonlyArray<string>;
    readonly pageOffset?: number;
    readonly outputsOnly?: boolean;
  } = {},
) {
  const { taskIds, pageOffset, outputsOnly } = options;
  const seeds = JSON.stringify(
    legacyTasks
      .filter((task) => task.threadId && (task.turnId || task.commandId))
      .map(({ id, threadId, turnId, commandId, slot }) => ({
        id,
        threadId,
        turnId,
        commandId,
        slot,
      })),
  );
  return sql<TurnRow>`
    WITH attributed AS (
      SELECT d.rowid AS orderId, d.delivery_id AS id, d.thread_id AS threadId,
        CASE WHEN d.state = 'accepted' THEN d.provider_turn_id END AS turnId, d.state,
        d.created_at AS createdAt,
        json_extract(d.event_json, '$.payload.workflowAttribution') AS attribution,
        json_extract(d.event_json, '$.payload.provider') AS provider,
        COALESCE(json_extract(d.event_json, '$.payload.modelSelection.model'),
          json_extract(d.event_json, '$.payload.model')) AS configuredModel,
        d.benchmark_reverted_at AS revertedAt
      FROM provider_turn_deliveries AS d
      WHERE json_extract(d.event_json, '$.payload.workflowAttribution.runKind') = ${input.runKind}
        AND json_extract(d.event_json, '$.payload.workflowAttribution.workflowId') = ${input.workflowId}
        ${
          taskIds?.length === 0
            ? sql`AND 0`
            : taskIds
              ? sql`AND json_extract(d.event_json, '$.payload.workflowAttribution.taskId') IN ${sql.in(taskIds)}`
              : sql``
        }
        AND json_extract(d.event_json, '$.type') = 'thread.turn-start-requested'
    ), legacy AS (
      SELECT COALESCE(d.rowid, 0) AS orderId,
        COALESCE(d.delivery_id, 'legacy:' || json_extract(seed.value,'$.id')) AS id,
        json_extract(seed.value,'$.threadId') AS threadId,
        COALESCE(json_extract(seed.value,'$.turnId'),
          CASE WHEN d.state = 'accepted' THEN d.provider_turn_id END) AS turnId,
        COALESCE(d.state,'accepted') AS state, COALESCE(d.created_at,'') AS createdAt,
        json_object('runKind', ${input.runKind}, 'workflowId', ${input.workflowId},
          'taskId', json_extract(seed.value,'$.id'),
          'originCommandId', COALESCE(d.command_id,'legacy:' || json_extract(seed.value,'$.id'))) AS attribution,
        json_extract(seed.value,'$.slot.provider') AS provider,
        json_extract(seed.value,'$.slot.model') AS configuredModel,
        d.benchmark_reverted_at AS revertedAt
      FROM json_each(${seeds}) AS seed
      LEFT JOIN provider_turn_deliveries AS d
        ON d.command_id = json_extract(seed.value,'$.commandId')
        AND d.thread_id = json_extract(seed.value,'$.threadId')
        AND json_extract(d.event_json, '$.payload.workflowAttribution') IS NULL
      WHERE (d.command_id IS NOT NULL OR json_extract(seed.value,'$.turnId') IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM attributed a WHERE a.threadId = json_extract(seed.value,'$.threadId')
            AND (a.turnId = json_extract(seed.value,'$.turnId') OR a.id = json_extract(seed.value,'$.commandId'))
        )
    ), deliveries AS (
      SELECT * FROM attributed UNION ALL SELECT * FROM legacy
    ), scoped AS (
      SELECT d.*, p.title, json_extract(d.attribution, '$.taskId') AS taskId,
        json_extract(d.attribution, '$.originCommandId') AS originId,
        EXISTS (
          SELECT 1 FROM provider_turn_deliveries AS other
          WHERE other.thread_id = d.threadId AND other.provider_turn_id = d.turnId
            AND other.state = 'accepted' AND other.delivery_id <> d.id
            AND json_extract(other.event_json, '$.type') = 'thread.turn-start-requested'
            AND COALESCE(json_extract(other.event_json, '$.payload.workflowAttribution.originCommandId'), other.command_id)
              <> json_extract(d.attribution, '$.originCommandId')
            AND (d.orderId > 0 OR json_extract(other.event_json, '$.payload.workflowAttribution') IS NOT NULL)
        ) AS conflicting
      FROM deliveries d
      JOIN projection_threads p ON p.thread_id = d.threadId AND p.project_id = ${projectId}
      ${
        outputsOnly
          ? sql`WHERE EXISTS (SELECT 1 FROM workflow_benchmark_outputs o
        WHERE o.run_kind = ${input.runKind} AND o.workflow_id = ${input.workflowId}
          AND o.task_id = json_extract(d.attribution, '$.taskId') AND o.turn_id = d.turnId
          AND o.thread_id = d.threadId)`
          : sql``
      }
    )
    ${
      pageOffset === undefined
        ? sql``
        : sql`
      , origins AS (
        SELECT *, MIN(orderId) OVER (PARTITION BY taskId, originId) AS firstOrder FROM scoped
      ), ranked AS (
        SELECT *, DENSE_RANK() OVER (PARTITION BY taskId ORDER BY firstOrder) AS attemptNumber,
          ROW_NUMBER() OVER (PARTITION BY threadId, turnId ORDER BY conflicting, orderId, id) AS duplicate
        FROM origins
      ), eligible AS (
        SELECT * FROM ranked WHERE conflicting = 0
          AND (turnId IS NULL OR duplicate = 1)
          AND NOT (id <> originId AND turnId IS NULL AND state = 'abandoned')
      ), latest AS (
        SELECT r.taskId, r.attemptNumber,
          CASE WHEN r.revertedAt IS NOT NULL THEN 'Reverted' ELSE COALESCE(t.state, r.state) END AS status,
          ROW_NUMBER() OVER (PARTITION BY r.taskId ORDER BY r.attemptNumber DESC, r.orderId DESC, r.id DESC) AS recency
        FROM ranked r LEFT JOIN projection_turns t ON t.thread_id = r.threadId AND t.turn_id = r.turnId
        WHERE NOT (r.id <> r.originId AND r.turnId IS NULL AND r.state = 'abandoned')
      ), metadata AS (
        SELECT (SELECT COUNT(*) FROM eligible) AS pageCount,
          (SELECT json_group_array(json_object('taskId', taskId, 'attempt', attemptNumber, 'status', status))
            FROM latest WHERE recency = 1) AS pageAttempts
      ), page AS (
        SELECT * FROM eligible ORDER BY orderId, id LIMIT 50 OFFSET ${pageOffset}
      )
    `
    }
    SELECT d.*, f.turn_id AS factId, f.model AS factModel, f.provider_name AS factProvider,
      ${pageOffset === undefined ? sql`NULL AS attemptNumber, NULL AS pageCount, NULL AS pageAttempts` : sql`metadata.*`},
      m.model AS effectiveModel, m.rerouted, COALESCE(f.recorded_at, f.completed_at) AS recordedAt,
      f.input_tokens AS input, f.output_tokens AS output, f.cache_read_tokens AS cacheRead,
      f.cache_write_tokens AS cacheWrite, f.total_tokens AS tokens, f.provider_cost_usd AS cost,
      t.state AS turnState, t.started_at AS startedAt, t.completed_at AS completedAt,
      EXISTS (
        SELECT 1 FROM next_turn_queue q JOIN next_turn_queue_state s ON s.thread_id = q.thread_id
        WHERE q.thread_id = d.threadId AND s.paused = 1 AND q.deleted_at IS NULL
          AND q.status IN ('queued','dispatching')
          AND json_extract(q.command_json,'$.workflowContinuationTurnId') = d.turnId
          AND NOT EXISTS (SELECT 1 FROM provider_turn_deliveries next
            WHERE next.command_id = q.command_id AND next.state = 'accepted')
      ) AS pausedContinuation
    FROM ${pageOffset === undefined ? sql`scoped d` : sql`metadata LEFT JOIN page d ON 1 = 1`}
    LEFT JOIN projection_turns AS t ON t.thread_id = d.threadId AND t.turn_id = d.turnId
    LEFT JOIN projection_turn_usage_facts AS f ON f.turn_id = d.turnId AND f.thread_id = d.threadId
      AND f.project_id = ${projectId}
    LEFT JOIN workflow_benchmark_turn_models AS m ON m.thread_id = d.threadId AND m.turn_id = d.turnId
    ORDER BY d.orderId, d.id
  `;
}

type Model = WorkflowBenchmarkTurn["model"];

const findingCaches = new WeakMap<
  SqlClient.SqlClient,
  Map<
    string,
    {
      revision: string;
      groups: ReturnType<typeof benchmarkFindings>;
    }
  >
>();

function groupedFindings(
  sql: SqlClient.SqlClient,
  run: Pick<WorkflowBenchmarkInput, "runKind" | "workflowId">,
  turns: readonly AttributedBenchmarkTurn[],
  outputs: readonly (BenchmarkOutputRow & { readonly version: string })[],
  subagents: ReadonlyMap<string, readonly BenchmarkSubagentEvidence[]>,
) {
  const cache = findingCaches.get(sql) ?? new Map();
  findingCaches.set(sql, cache);
  const byTurn = new Map(
    turns
      .filter(({ turn }) => turn.turnId && turn.threadId)
      .map((entry) => [workflowTurnKey(entry.turn.threadId!, entry.turn.turnId!), entry]),
  );
  const revision = JSON.stringify(
    outputs.map((row) => {
      const turn = byTurn.get(workflowTurnKey(row.threadId, row.turnId));
      return [
        row.version,
        turn?.turn.model,
        turn?.turn.status,
        turn?.turn.reviewer,
        turn?.attribution,
        subagents.get(workflowTurnKey(row.threadId, row.turnId)),
      ];
    }),
  );
  const key = JSON.stringify([run.runKind, run.workflowId]);
  const cached = cache.get(key);
  if (cached?.revision === revision) return cached.groups;
  const groups = benchmarkFindings(turns, outputs, subagents);
  cache.delete(key);
  cache.set(key, { revision, groups });
  if (cache.size > 8) cache.delete(cache.keys().next().value!);
  return groups;
}
export function benchmarkModel(provider: string | null, reported: string | null): Model {
  if (!reported) return { id: "unknown", label: "Unknown model" };
  const canonical =
    provider && isKnownProviderKind(provider)
      ? (normalizeModelSlug(reported, provider) ?? reported)
      : reported;
  const catalog = provider && isKnownProviderKind(provider) ? getModelOptions(provider) : [];
  const label =
    catalog.find((model) => model.slug === canonical)?.name ??
    (provider ? formatModelDisplayName(provider, canonical) : undefined) ??
    reported;
  return { id: canonical, label };
}

function usageForRow(
  row: TurnRow,
  provider: string | null,
  pricingModel: string | null,
  overrides: readonly UsagePriceOverride[],
  aliases: ReadonlyMap<string, string>,
): WorkflowBenchmarkUsage {
  if (
    row.state === "pending" ||
    row.state === "sending" ||
    (row.state === "accepted" &&
      !row.startedAt &&
      !row.completedAt &&
      !row.factId &&
      !row.revertedAt)
  ) {
    return { ...emptyUsage(), pending: 1 };
  }
  const cost = applyPriceOverride<UsageAggregateRow>(
    {
      provider: provider ?? "",
      model: pricingModel ? (aliases.get(pricingModel) ?? pricingModel) : null,
      turnCount: 1,
      reportedTokenTurnCount: Number(
        row.input !== null || row.output !== null || row.tokens !== null,
      ),
      estimationEligibleTurnCount: Number(row.input !== null && row.output !== null),
      inputTokens: row.input ?? 0,
      outputTokens: row.output ?? 0,
      cacheReadTokens: row.cacheRead ?? 0,
      cacheWriteTokens: row.cacheWrite ?? 0,
      totalTokens: row.tokens ?? 0,
      providerReportedCostUsd: row.cost,
      pricedTurnCount: Number(row.cost !== null),
      unpricedTurnCount: Number(row.cost === null),
      recordedTurnCount: Number(row.factId !== null),
      legacyCostEventCount: 0,
      inputTokenTurnCount: Number(row.input !== null),
      outputTokenTurnCount: Number(row.output !== null),
      cacheReadTokenTurnCount: Number(row.cacheRead !== null),
      cacheWriteTokenTurnCount: Number(row.cacheWrite !== null),
      totalTokenTurnCount: Number(row.tokens !== null),
    },
    overrides,
  );
  const costUsd = row.cost ?? cost.estimatedCostUsd ?? null;
  const estimatedCodexCredits =
    provider === "codex" && row.cost === null && !row.rerouted
      ? estimateCodexStandardCredits(
          row.effectiveModel ?? pricingModel,
          row.input,
          row.cacheRead,
          row.output,
        )
      : undefined;
  return {
    tokens: row.tokens,
    costUsd,
    estimated: cost.estimatedCostUsd !== undefined,
    ...(estimatedCodexCredits !== undefined ? { estimatedCodexCredits } : {}),
    missingTokens: Number(row.tokens === null),
    missingCost: Number(costUsd === null),
    pending: Number(Boolean(row.pausedContinuation && !row.revertedAt)),
  };
}

function emptyUsage(): WorkflowBenchmarkUsage {
  return {
    tokens: null,
    costUsd: null,
    estimated: false,
    missingTokens: 0,
    missingCost: 0,
    pending: 0,
  };
}

function sumUsage(a: WorkflowBenchmarkUsage, b: WorkflowBenchmarkUsage): WorkflowBenchmarkUsage {
  return {
    tokens: a.tokens === null && b.tokens === null ? null : (a.tokens ?? 0) + (b.tokens ?? 0),
    costUsd: a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0),
    estimated: a.estimated || b.estimated,
    ...(a.estimatedCodexCredits !== undefined || b.estimatedCodexCredits !== undefined
      ? { estimatedCodexCredits: (a.estimatedCodexCredits ?? 0) + (b.estimatedCodexCredits ?? 0) }
      : {}),
    missingTokens: a.missingTokens + b.missingTokens,
    missingCost: a.missingCost + b.missingCost,
    pending: a.pending + b.pending,
  };
}

export interface AttributedBenchmarkTurn {
  readonly provider?: string | null;
  turn: WorkflowBenchmarkTurn;
  readonly attribution: WorkflowAttribution;
  readonly phase: WorkflowBenchmarkPhase;
}

function duration(row: TurnRow) {
  if (!row.startedAt || !row.completedAt) return null;
  const ms = Date.parse(row.completedAt) - Date.parse(row.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function getWorkflowBenchmark(
  sql: SqlClient.SqlClient,
  input: WorkflowBenchmarkInput,
  run: BenchmarkWorkflow,
  settings: {
    readonly usageModelAliases: Readonly<Record<string, string>>;
    readonly usagePriceOverrides: readonly UsagePriceOverride[];
  },
): Effect.Effect<WorkflowBenchmarkResult, import("effect/unstable/sql/SqlError").SqlError> {
  return Effect.gen(function* () {
    const [cutover] = yield* sql<{
      startedAt: string;
    }>`SELECT started_at AS startedAt FROM workflow_benchmark_cutover`;
    const historicalPartial = Boolean(cutover && run.createdAt < cutover.startedAt);
    const tasks = benchmarkTasks(run);
    const phases = benchmarkPhases(run);
    const select = input.select;
    const phaseTasks =
      select.kind === "turns"
        ? tasks.filter((task) => benchmarkPhase(task.id) === select.phase)
        : tasks;
    const rows = yield* benchmarkDeliveryRows(
      sql,
      input,
      run.projectId,
      historicalPartial ? phaseTasks : [],
      select.kind === "turns"
        ? { taskIds: phaseTasks.map((task) => task.id), pageOffset: select.offset ?? 0 }
        : { outputsOnly: select.kind === "findings" },
    );
    const aliases = resolveModelAliases(settings.usageModelAliases);
    const turns: AttributedBenchmarkTurn[] = [];
    const modelMap = new Map<string, Model>();
    const attempts = new Map<string, Map<string, number>>();
    const seen = new Set<string>();
    const ambiguous = new Set<string>();
    const latestStatus = new Map<string, string>();
    const pagedAttempts = new Map<string, number>();
    if (rows[0]?.pageAttempts) {
      const overview = JSON.parse(rows[0].pageAttempts) as Array<{
        taskId: string;
        attempt: number;
        status: string;
      }>;
      for (const { taskId, attempt, status } of overview) {
        pagedAttempts.set(taskId, attempt);
        latestStatus.set(taskId, status);
      }
    }
    for (const row of rows) {
      if (!row.attribution) continue;
      const attribution = readAttribution(row.attribution);
      const phase = benchmarkPhase(attribution.taskId);
      if (!phase || !phases.includes(phase)) continue;
      if (row.id !== attribution.originCommandId && !row.turnId && row.state === "abandoned")
        continue;
      const byOrigin = attempts.get(attribution.taskId) ?? new Map<string, number>();
      attempts.set(attribution.taskId, byOrigin);
      const attempt =
        row.attemptNumber ?? byOrigin.get(attribution.originCommandId) ?? byOrigin.size + 1;
      byOrigin.set(attribution.originCommandId, attempt);
      if (select.kind !== "turns" && attempt === byOrigin.size)
        latestStatus.set(
          attribution.taskId,
          row.revertedAt ? "Reverted" : (row.turnState ?? row.state),
        );
      const turnKey = row.turnId ? workflowTurnKey(row.threadId, row.turnId) : null;
      if (turnKey && row.conflicting) {
        ambiguous.add(turnKey);
        continue;
      }
      if (turnKey && seen.has(turnKey)) continue;
      if (turnKey) seen.add(turnKey);
      const historicalModel =
        cutover && row.recordedAt && row.recordedAt < cutover.startedAt ? row.factModel : null;
      const provider = row.factProvider ?? row.provider;
      const rawModel = row.effectiveModel ?? historicalModel ?? row.configuredModel;
      const model = benchmarkModel(provider, rawModel);
      modelMap.set(model.id, model);
      const role = benchmarkRole(attribution.taskId);
      const target = attribution.reviewTarget ?? null;
      const reviewer =
        benchmarkOutputKind(attribution.taskId) === "findings"
          ? {
              id: attribution.taskId,
              label: row.title ?? (target ? `${role} · ${target.label}` : role),
            }
          : undefined;
      const usage =
        select.kind === "findings"
          ? emptyUsage()
          : usageForRow(
              row,
              provider,
              row.factModel ?? rawModel,
              settings.usagePriceOverrides,
              aliases,
            );
      turns.push({
        attribution,
        phase,
        provider,
        turn: {
          id: row.id,
          threadId: ThreadId.make(row.threadId),
          threadTitle: row.title,
          turnId: row.turnId ? TurnId.make(row.turnId) : null,
          model,
          modelSource: row.effectiveModel
            ? "effective"
            : historicalModel
              ? "historical"
              : row.configuredModel
                ? "configured"
                : "unknown",
          role,
          attempt,
          durationMs: duration(row),
          status: row.revertedAt
            ? "Reverted"
            : row.pausedContinuation
              ? "Pending continuation (paused)"
              : (row.turnState ?? row.state),
          target,
          aggregateRerouteUsage: row.rerouted === 1,
          ...(reviewer ? { reviewer } : {}),
          ...(usage.tokens !== null
            ? ({ tokenScope: provider === "claudeAgent" ? "main-agent" : "unknown" } as const)
            : {}),
          ...(usage.costUsd !== null
            ? ({
                costScope:
                  provider === "claudeAgent"
                    ? usage.estimated
                      ? "main-agent"
                      : "provider-total"
                    : "unknown",
              } as const)
            : {}),
          usage,
        },
      });
    }
    const pending: AttributedBenchmarkTurn[] = [];
    for (const task of select.kind === "findings" ? [] : phaseTasks) {
      const previousStatus = latestStatus.get(task.id);
      if (
        (previousStatus &&
          !["failed", "interrupted", "rejected", "abandoned", "Reverted"].includes(
            previousStatus,
          )) ||
        ![
          "running",
          "pending",
          "pending_start",
          "authoring",
          "revising",
          "implementing",
          "in_progress",
          "reader_requested",
          "reader_running",
          "polishing",
        ].includes(task.status)
      )
        continue;
      const phase = benchmarkPhase(task.id);
      if (!phase) continue;
      const model = benchmarkModel(task.slot.provider, task.slot.model);
      modelMap.set(model.id, model);
      pending.push({
        phase,
        attribution: {
          runKind: input.runKind,
          workflowId: input.workflowId,
          taskId: task.id,
          originCommandId: "pending" as WorkflowAttribution["originCommandId"],
        },
        turn: {
          id: `pending:${task.id}`,
          threadId: task.threadId,
          threadTitle: null,
          turnId: null,
          model,
          modelSource: "configured",
          role: benchmarkRole(task.id),
          attempt: (pagedAttempts.get(task.id) ?? attempts.get(task.id)?.size ?? 0) + 1,
          durationMs: null,
          status: "pending",
          target: null,
          aggregateRerouteUsage: false,
          usage: { ...emptyUsage(), pending: 1 },
        },
      });
    }
    if (select.kind === "turns") {
      const deliveryCount = rows[0]?.pageCount ?? 0;
      const offset = select.offset ?? 0;
      const agents = yield* readBenchmarkSubagents(
        sql,
        turns.map(({ turn, provider }) => ({
          threadId: turn.threadId,
          turnId: turn.turnId,
          provider: provider ?? null,
        })),
      );
      const items = turns.map(({ turn, provider }) => {
        const children =
          turn.threadId && turn.turnId
            ? agents.get(workflowTurnKey(turn.threadId, turn.turnId))
            : undefined;
        return children?.length
          ? {
              ...turn,
              subagents: children.map(({ id, label, status, model, tokens, costUsd }) => ({
                id,
                label,
                status,
                model: model ? benchmarkModel(provider ?? null, model) : null,
                tokens,
                costUsd,
              })),
            }
          : turn;
      });
      return {
        kind: "turns",
        items: [
          ...items,
          ...pending
            .slice(
              Math.max(0, offset - deliveryCount),
              Math.max(0, offset - deliveryCount) + 50 - items.length,
            )
            .map(({ turn }) => turn),
        ],
        count: deliveryCount + pending.length,
      };
    }
    turns.push(...pending);
    const labels = new Map<string, number>();
    for (const { label } of modelMap.values()) labels.set(label, (labels.get(label) ?? 0) + 1);
    for (const model of modelMap.values())
      if ((labels.get(model.label) ?? 0) > 1) {
        modelMap.set(model.id, { ...model, label: `${model.label} (${model.id})` });
      }
    for (const entry of turns)
      entry.turn = { ...entry.turn, model: modelMap.get(entry.turn.model.id)! };
    const outputs = yield* sql<BenchmarkOutputRow & { readonly version: string }>`
      SELECT o.thread_id AS threadId, o.turn_id AS turnId, o.task_id AS taskId, o.kind, o.coverage,
        o.metadata_json AS metadata, o.message_id AS messageId, o.plan_id AS planId,
        json_array(o.rowid, o.task_id, o.turn_id, o.captured_at, o.message_id, o.plan_id) AS version
      FROM workflow_benchmark_outputs AS o
      JOIN projection_turns t ON t.thread_id = o.thread_id AND t.turn_id = o.turn_id AND t.state = 'completed'
      WHERE o.run_kind = ${input.runKind} AND o.workflow_id = ${input.workflowId}
      ORDER BY o.rowid
    `;
    const referencedTurns = new Set(
      outputs.flatMap((row) =>
        row.kind === "findings" && row.metadata?.includes('"subagentFinding"')
          ? [workflowTurnKey(row.threadId, row.turnId)]
          : [],
      ),
    );
    const agents = yield* readBenchmarkSubagents(
      sql,
      turns.flatMap(({ turn, provider }) =>
        turn.threadId &&
        turn.turnId &&
        referencedTurns.has(workflowTurnKey(turn.threadId, turn.turnId))
          ? [{ threadId: turn.threadId, turnId: turn.turnId, provider: provider ?? null }]
          : [],
      ),
    );
    const findings = groupedFindings(sql, input, turns, outputs, agents);
    if (select.kind === "findings") return findings.page(select);
    const coverage = new Map<
      string,
      { model: string; structured: number; completed: number; invalid: number }
    >();
    const outputByTurn = new Map(
      outputs.map((row) => [workflowTurnKey(row.threadId, row.turnId), row]),
    );
    const cells = new Map<WorkflowBenchmarkPhase, Map<string, WorkflowBenchmarkUsage>>();
    const modelTotals = new Map<string, WorkflowBenchmarkUsage>();
    let total = emptyUsage();
    let evaluationsIncomplete = 0;
    for (const { phase, turn, attribution } of turns) {
      const phaseCells = cells.get(phase) ?? new Map<string, WorkflowBenchmarkUsage>();
      phaseCells.set(
        turn.model.id,
        sumUsage(phaseCells.get(turn.model.id) ?? emptyUsage(), turn.usage),
      );
      cells.set(phase, phaseCells);
      modelTotals.set(
        turn.model.id,
        sumUsage(modelTotals.get(turn.model.id) ?? emptyUsage(), turn.usage),
      );
      total = sumUsage(total, turn.usage);
      if (
        benchmarkOutputKind(attribution.taskId) === "dispositions" &&
        (attribution.findingRefs?.length ?? 0) > 0 &&
        turn.turnId &&
        turn.threadId &&
        turn.status !== "Reverted" &&
        turn.status !== "running" &&
        outputByTurn.get(workflowTurnKey(turn.threadId, turn.turnId))?.coverage !== "structured"
      ) {
        evaluationsIncomplete++;
      }
      if (
        turn.status !== "completed" ||
        !turn.turnId ||
        benchmarkOutputKind(attribution.taskId) !== "findings"
      )
        continue;
      const row = outputByTurn.get(workflowTurnKey(turn.threadId!, turn.turnId));
      const stats = coverage.get(turn.model.id) ?? {
        model: turn.model.id,
        structured: 0,
        completed: 0,
        invalid: 0,
      };
      stats.completed++;
      stats.structured += Number(row?.coverage === "structured");
      stats.invalid += Number(row?.coverage === "invalid");
      coverage.set(turn.model.id, stats);
    }
    const toCells = (map: ReadonlyMap<string, WorkflowBenchmarkUsage>) =>
      Array.from(map, ([model, usage]) => ({ model, usage }));
    return {
      kind: "summary",
      models: [...modelMap.values()].sort(
        (a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
      ),
      phases: phases.map((id) => {
        const phaseCells = cells.get(id) ?? new Map<string, WorkflowBenchmarkUsage>();
        const reviewTurns = turns.filter((entry) => entry.phase === id && entry.turn.reviewer);
        return {
          id,
          label: BENCHMARK_PHASES[id],
          cells: toCells(phaseCells),
          total: [...phaseCells.values()].reduce(sumUsage, emptyUsage()),
          findings: findings.count(id),
          review: id === "reviews" || id === "code-review" || id === "reader-review",
          ...(reviewTurns.length
            ? {
                reviewers: [
                  ...new Map(
                    reviewTurns.map(({ turn }) => [turn.reviewer!.id, turn.reviewer!]),
                  ).values(),
                ],
                findingTurns: reviewTurns.flatMap(({ turn }) => {
                  const count =
                    turn.threadId && turn.turnId
                      ? findings.turnCount(turn.threadId, turn.turnId)
                      : null;
                  return count ? [count] : [];
                }),
              }
            : {}),
        };
      }),
      total,
      modelTotals: toCells(modelTotals),
      findings: findings.total,
      historicalPartial,
      ambiguous: ambiguous.size,
      evaluationsIncomplete,
      coverage: [...coverage.values()],
    };
  });
}
