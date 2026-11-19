import { Schema, Effect } from "effect";
import {
  WorkflowAttribution,
  WorkflowReviewTarget,
  PlanningWorkflow,
  CodeReviewWorkflow,
  InvestigationWorkflow,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ThreadId,
} from "@t3tools/contracts";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  benchmarkOutputKind,
  benchmarkRunKind,
  benchmarkTasks,
  type BenchmarkWorkflow,
} from "./workflowBenchmarkTasks.ts";
import {
  decodeFindings,
  decodeDispositions,
  parseWorkflowFindingOutput,
  WORKFLOW_DISPOSITIONS_INSTRUCTIONS,
  workflowFindingRef,
  type FindingProtocolOutput,
  type Disposition,
  type StoredDisposition,
} from "./workflowFindingProtocol.ts";
import {
  workflowArtifactFit,
  WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT,
  selectWorkflowReport,
  workflowPromptFitError,
} from "./workflowSharedUtils.ts";
import { roughTokenEstimateFromCharacters } from "@t3tools/shared/model";
import {
  findingFileLocation,
  isWithinEvidenceWorkspace,
  verifiesPatchCorrection,
  verifiesPlanCorrection,
  verifiesTargetedTest,
  workspaceRelativeEvidencePath,
} from "./workflowFindingEvidence.ts";

export const readAttribution = Schema.decodeUnknownSync(Schema.fromJsonString(WorkflowAttribution));
const readReviewTarget = Schema.decodeUnknownSync(Schema.fromJsonString(WorkflowReviewTarget));
const readChangedFiles = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

export const bestEffortBenchmark = <A>(operation: string, fallback: A) =>
  Effect.catchCause((cause) =>
    Effect.logWarning("Workflow benchmark operation failed", { operation, cause }).pipe(
      Effect.as(fallback),
    ),
  );
type TurnCommand = Extract<
  OrchestrationCommand,
  { type: "thread.turn.start" | "thread.turn.steer" }
>;
type PendingEvent<T = OrchestrationEvent> = T extends OrchestrationEvent
  ? Omit<T, "sequence">
  : never;

export function findWorkflowRun(event: OrchestrationEvent): BenchmarkWorkflow | null {
  switch (event.type) {
    case "project.workflow-upserted":
    case "project.code-review-workflow-upserted":
    case "project.investigation-workflow-upserted":
    case "project.debug-workflow-upserted":
      return event.payload.workflow;
    default:
      return null;
  }
}

export const findWorkflowTurnAttribution = (
  sql: SqlClient.SqlClient,
  threadId: string,
  turnId: string,
  includeReverted = false,
) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ attribution: string | null }>`
      SELECT DISTINCT json_extract(d.event_json, '$.payload.workflowAttribution') AS attribution
      FROM provider_turn_deliveries AS d
      WHERE d.thread_id = ${threadId} AND d.provider_turn_id = ${turnId} AND d.state = 'accepted'
        AND (${includeReverted} OR d.benchmark_reverted_at IS NULL)
        AND json_extract(d.event_json, '$.type') = 'thread.turn-start-requested'
    `;
    const row = rows[0];
    return rows.length === 1 && row?.attribution ? readAttribution(row.attribution) : null;
  });

/** A provider may stream before its start call returns a receipt. The F5 turn's
 * exact pending message can identify the protocol for capture while that send
 * is in flight. Counts and decisions still require the accepted receipt. */
function findInFlightArtifactAttribution(
  sql: SqlClient.SqlClient,
  threadId: string,
  turnId: string,
) {
  return Effect.gen(function* () {
    const rows = yield* sql<{ attribution: string | null }>`
      SELECT json_extract(d.event_json,'$.payload.workflowAttribution') AS attribution
      FROM projection_turns t JOIN provider_turn_deliveries d
        ON d.thread_id = t.thread_id AND d.message_id = t.pending_message_id
      WHERE t.thread_id = ${threadId} AND t.turn_id = ${turnId} AND d.state IN ('sending','ambiguous','rejected')
        AND d.attempt_id IS NOT NULL AND json_extract(d.event_json,'$.type') = 'thread.turn-start-requested'
        AND NOT EXISTS (SELECT 1 FROM provider_turn_deliveries accepted
          WHERE accepted.thread_id = t.thread_id AND accepted.provider_turn_id = t.turn_id
            AND accepted.state = 'accepted' AND json_extract(accepted.event_json,'$.type') = 'thread.turn-start-requested')
    `;
    return rows.length === 1 && rows[0]?.attribution ? readAttribution(rows[0].attribution) : null;
  });
}

export function prepareWorkflowBenchmarkDispatch(
  sql: SqlClient.SqlClient,
  command: TurnCommand,
  steerFallback: boolean,
  readModel: OrchestrationReadModel,
) {
  const sourceTurnId =
    command.workflowContinuationTurnId ??
    (command.type === "thread.turn.steer" ? command.expectedTurnId : undefined);
  if (!command.workflowAttribution && !sourceTurnId && !steerFallback) {
    return Effect.succeed(command);
  }
  return Effect.gen(function* () {
    let attribution = command.workflowAttribution;
    if (steerFallback) {
      const [row] = yield* sql<{ attribution: string | null }>`
        SELECT json_extract(event_json, '$.payload.workflowAttribution') AS attribution
        FROM provider_turn_deliveries WHERE command_id = ${command.commandId} AND thread_id = ${command.threadId}
      `;
      if (row?.attribution) attribution = readAttribution(row.attribution);
    }
    if (!attribution && sourceTurnId) {
      attribution =
        (yield* findWorkflowTurnAttribution(sql, command.threadId, sourceTurnId)) ?? undefined;
    }
    if (!attribution) return command;
    const attributed = { ...command, workflowAttribution: attribution };
    if (
      attribution.originCommandId !== command.commandId ||
      steerFallback ||
      attribution.findingRefs !== undefined ||
      benchmarkOutputKind(attribution.taskId) !== "dispositions"
    )
      return attributed;

    const rows = yield* sql<{
      taskId: string;
      threadId: string;
      turnId: string;
      metadata: string;
    }>`
      SELECT o.task_id AS taskId, o.thread_id AS threadId, o.turn_id AS turnId, o.metadata_json AS metadata
      FROM workflow_benchmark_outputs o
      JOIN projection_turns t ON t.thread_id = o.thread_id AND t.turn_id = o.turn_id AND t.state = 'completed'
      WHERE o.run_kind = ${attribution.runKind} AND o.workflow_id = ${attribution.workflowId}
        AND o.kind = 'findings' AND o.coverage = 'structured'
      ORDER BY o.rowid
    `;
    const runs =
      attribution.runKind === "planning"
        ? readModel.planningWorkflows
        : attribution.runKind === "codeReview"
          ? readModel.codeReviewWorkflows
          : readModel.investigationWorkflows;
    const run = runs.find((entry) => entry.id === attribution.workflowId);
    const tasks = run ? benchmarkTasks(run) : [];
    const pins = new Map(tasks.map((task) => [task.id, task.turnId]));
    const task = tasks.find((entry) => entry.id === attribution.taskId);
    const fit = task
      ? workflowArtifactFit({
          artifacts: [command.message.text],
          targetSlot: task.slot,
          thread: readModel.threads.find((thread) => thread.id === command.threadId) ?? null,
        })
      : null;
    const heading = `\n\n${WORKFLOW_DISPOSITIONS_INSTRUCTIONS}\n\nFinding references (JSON lines)\n`;
    let remaining =
      Math.min(12_000, WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT - command.message.text.length) -
      heading.length;
    if (remaining <= 0) return attributed;
    const tokenBudget = fit ? Math.max(0, fit.availableTokens - fit.estimatedTokens) : Infinity;
    let used = heading.length;
    const refs: string[] = [];
    const lines: string[] = [];
    for (const row of rows) {
      if (pins.get(row.taskId) !== row.turnId || !acceptsSourceTask(attribution.taskId, row.taskId))
        continue;
      for (const finding of decodeFindings(JSON.parse(row.metadata))) {
        const ref = workflowFindingRef(row.threadId, row.turnId, finding.id);
        const line = JSON.stringify({
          ref,
          origin: row.taskId,
          severity: finding.severity,
          title: finding.title,
          location: finding.location,
        });
        if (
          line.length + 1 > remaining ||
          roughTokenEstimateFromCharacters(used + line.length + 1) > tokenBudget
        )
          continue;
        lines.push(line);
        refs.push(ref);
        remaining -= line.length + 1;
        used += line.length + 1;
      }
    }
    if (!lines.length) return attributed;
    const prompt = command.message.text + heading + lines.join("\n");
    if (
      task &&
      workflowPromptFitError({
        prompt,
        artifacts: [prompt],
        targetSlot: task.slot,
        thread: readModel.threads.find((thread) => thread.id === command.threadId) ?? null,
        artifactLabel: "Workflow prompt with finding references",
        enforceArtifactBudget: true,
      })
    )
      return attributed;
    return {
      ...attributed,
      workflowAttribution: { ...attribution, findingRefs: refs },
      message: { ...command.message, text: prompt },
    };
  });
}

export function reconcileMissingBenchmarkOutputs(
  sql: SqlClient.SqlClient,
  readModel: OrchestrationReadModel,
) {
  return Effect.gen(function* () {
    const runs = [
      ...readModel.planningWorkflows,
      ...readModel.codeReviewWorkflows,
      ...readModel.investigationWorkflows,
    ];
    const byKey = new Map(
      runs
        .filter((run) => !run.deletedAt)
        .map((run) => [JSON.stringify([benchmarkRunKind(run), run.id]), run]),
    );
    const missing = yield* sql<{
      runKind: string;
      workflowId: string;
      taskId: string;
      turnId: string;
    }>`
      SELECT DISTINCT json_extract(d.event_json, '$.payload.workflowAttribution.runKind') AS runKind,
        json_extract(d.event_json, '$.payload.workflowAttribution.workflowId') AS workflowId,
        json_extract(d.event_json, '$.payload.workflowAttribution.taskId') AS taskId,
        d.provider_turn_id AS turnId
      FROM provider_turn_deliveries d
      WHERE d.state = 'accepted' AND d.provider_turn_id IS NOT NULL AND d.benchmark_reverted_at IS NULL
        AND json_extract(d.event_json, '$.type') = 'thread.turn-start-requested'
        AND json_extract(d.event_json, '$.payload.workflowAttribution.runKind') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM workflow_benchmark_outputs o
          WHERE o.run_kind = json_extract(d.event_json, '$.payload.workflowAttribution.runKind')
            AND o.workflow_id = json_extract(d.event_json, '$.payload.workflowAttribution.workflowId')
            AND o.task_id = json_extract(d.event_json, '$.payload.workflowAttribution.taskId')
            AND o.turn_id = d.provider_turn_id)
    `;
    const candidates = new Set<BenchmarkWorkflow>();
    for (const row of missing) {
      if (!benchmarkOutputKind(row.taskId)) continue;
      const run = byKey.get(JSON.stringify([row.runKind, row.workflowId]));
      if (
        run &&
        benchmarkTasks(run).some((task) => task.id === row.taskId && task.turnId === row.turnId)
      )
        candidates.add(run);
    }
    for (const run of candidates) {
      yield* materializeWorkflowBenchmark(sql, run, run.updatedAt).pipe(
        bestEffortBenchmark("reconcile saved run", undefined),
      );
    }
  }).pipe(bestEffortBenchmark("find missing outputs", undefined));
}

/** ACP and recovered deliveries can be accepted after the final artifact is already durable. */
export function reconcileAcceptedBenchmarkDelivery(sql: SqlClient.SqlClient, id: string) {
  return Effect.gen(function* () {
    const [row] = yield* sql<{ attribution: string | null }>`
      SELECT json_extract(event_json, '$.payload.workflowAttribution') AS attribution
      FROM provider_turn_deliveries WHERE delivery_id = ${id}
    `;
    if (!row?.attribution) return;
    const attribution = readAttribution(row.attribution);
    const table =
      attribution.runKind === "planning"
        ? "projection_planning_workflows"
        : attribution.runKind === "codeReview"
          ? "projection_code_review_workflows"
          : "projection_investigation_workflows";
    const [projected] = yield* sql<{ workflowJson: string }>`
      SELECT workflow_json AS workflowJson FROM ${sql(table)}
      WHERE workflow_id = ${attribution.workflowId} AND deleted_at IS NULL
    `;
    if (!projected) return;
    const run = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Union([PlanningWorkflow, CodeReviewWorkflow, InvestigationWorkflow]),
      ),
    )(projected.workflowJson);
    yield* materializeWorkflowBenchmark(sql, run, run.updatedAt);
  });
}

function acceptsSourceTask(taskId: string, source: string): boolean {
  if (taskId.startsWith("revision-"))
    return (
      source.endsWith(taskId.slice(-2)) &&
      (source.startsWith("cross-review-") || source.startsWith("self-review-"))
    );
  if (taskId === "apply-feedback") return source.startsWith("implementation-review-");
  if (taskId === "polish") return source === "reader-review";
  return taskId === "synthesis" || taskId === "consolidation";
}

/** Strip protocol metadata before the public artifact is committed. */
export function captureWorkflowBenchmarkArtifact(
  sql: SqlClient.SqlClient,
  event: PendingEvent,
  readModel: OrchestrationReadModel,
) {
  return Effect.gen(function* () {
    const plan = event.type === "thread.proposed-plan-upserted" ? event.payload.proposedPlan : null;
    const message =
      event.type === "thread.message-sent" &&
      event.payload.role === "assistant" &&
      !event.payload.streaming
        ? event.payload
        : null;
    const existingText =
      message && !message.text
        ? readModel.threads
            .find((thread) => thread.id === message.threadId)
            ?.messages.find(
              (entry) => entry.id === message.messageId && entry.turnId === message.turnId,
            )?.text
        : undefined;
    const text = plan?.planMarkdown ?? existingText ?? message?.text;
    const turnId = plan?.turnId ?? message?.turnId;
    if (!turnId || !text || !text.includes("f5-finding")) return event;
    if (event.type !== "thread.proposed-plan-upserted" && event.type !== "thread.message-sent")
      return event;
    const threadId = event.payload.threadId;
    const attribution =
      (yield* findWorkflowTurnAttribution(sql, threadId, turnId)) ??
      (yield* findInFlightArtifactAttribution(sql, threadId, turnId));
    const kind = attribution ? benchmarkOutputKind(attribution.taskId) : null;
    const runs = attribution
      ? []
      : [
          ...readModel.planningWorkflows,
          ...readModel.codeReviewWorkflows,
          ...readModel.investigationWorkflows,
        ];
    const owner =
      attribution ??
      runs
        .flatMap((run) =>
          run.deletedAt
            ? []
            : benchmarkTasks(run)
                .filter((task) => task.threadId === threadId && benchmarkOutputKind(task.id))
                .map((task) => ({
                  runKind: benchmarkRunKind(run),
                  workflowId: run.id,
                  taskId: task.id,
                })),
        )
        .find((task) => {
          const candidate = benchmarkOutputKind(task.taskId);
          return (
            candidate && parseWorkflowFindingOutput(text, candidate).coverage !== "unavailable"
          );
        });
    const outputKind = kind ?? (owner && benchmarkOutputKind(owner.taskId));
    if (!owner || !outputKind) return event;
    const parsed = parseWorkflowFindingOutput(text, outputKind);
    if (parsed.coverage === "unavailable") return event;
    yield* sql`
      INSERT INTO workflow_benchmark_artifacts
        (run_kind, workflow_id, thread_id, turn_id, artifact_id, artifact_kind, kind, coverage, metadata_json)
      VALUES (${owner.runKind}, ${owner.workflowId}, ${threadId}, ${turnId},
        ${plan?.id ?? message!.messageId}, ${plan ? "plan" : "message"},
        ${outputKind}, ${parsed.coverage}, ${parsed.metadata ? JSON.stringify(parsed.metadata) : null})
      ON CONFLICT(thread_id, turn_id, artifact_kind, artifact_id)
      DO UPDATE SET coverage = excluded.coverage, metadata_json = excluded.metadata_json,
        run_kind = excluded.run_kind, workflow_id = excluded.workflow_id
    `;
    return event.type === "thread.proposed-plan-upserted"
      ? {
          ...event,
          payload: {
            ...event.payload,
            proposedPlan: { ...event.payload.proposedPlan, planMarkdown: parsed.markdown },
          },
        }
      : {
          ...event,
          payload: { ...event.payload, text: parsed.markdown, replaceText: true as const },
        };
  });
}

interface OutputSource {
  readonly id: string;
  readonly text: string;
  readonly coverage: FindingProtocolOutput["coverage"] | null;
  readonly metadata: string | null;
}

function verifyFindingDisposition(
  sql: SqlClient.SqlClient,
  run: BenchmarkWorkflow,
  task: { readonly id: string; readonly threadId: ThreadId; readonly turnId: string },
  plan: OutputSource | undefined,
  disposition: Disposition,
) {
  return Effect.gen(function* (): Effect.fn.Return<
    StoredDisposition,
    import("effect/unstable/sql/SqlError").SqlError
  > {
    if (disposition.verdict !== "confirmed") return disposition;
    const parts = disposition.ref.split("/");
    if (parts.length !== 3) return disposition;
    const [sourceThread, sourceTurn, localId] = parts.map(decodeURIComponent);
    if (!sourceThread || !sourceTurn || !localId) return disposition;
    const [source] = yield* sql<{ metadata: string; target: string | null }>`
      SELECT o.metadata_json AS metadata, json_extract(d.event_json, '$.payload.workflowAttribution.reviewTarget') AS target
      FROM workflow_benchmark_outputs o
      JOIN provider_turn_deliveries d ON d.thread_id = o.thread_id AND d.provider_turn_id = o.turn_id
        AND d.state = 'accepted' AND d.benchmark_reverted_at IS NULL
        AND json_extract(d.event_json, '$.type') = 'thread.turn-start-requested'
      WHERE o.run_kind = ${benchmarkRunKind(run)} AND o.workflow_id = ${run.id}
        AND o.thread_id = ${sourceThread} AND o.turn_id = ${sourceTurn} AND o.kind = 'findings' AND o.coverage = 'structured'
      LIMIT 1
    `;
    const finding =
      source && decodeFindings(JSON.parse(source.metadata)).find((entry) => entry.id === localId);
    if (!source || !finding) return disposition;
    const target = source.target ? readReviewTarget(source.target) : null;
    const workspace = (yield* sql<{ root: string }>`
      SELECT COALESCE(t.worktree_path, p.workspace_root) AS root
      FROM projection_threads t JOIN projection_projects p ON t.project_id = p.project_id
      WHERE t.thread_id = ${task.threadId}
    `)[0]?.root;
    let correction: { id: string; completedAt: string } | undefined;
    let verifiedResolution: StoredDisposition["verifiedResolution"];
    if (
      disposition.evidence?.trim() &&
      disposition.resolution === "addressed" &&
      task.id === "synthesis"
    ) {
      verifiedResolution = "addressed";
    }
    if (
      disposition.evidence?.trim() &&
      disposition.resolution === "fixed" &&
      disposition.correction
    ) {
      const excerpts = disposition.correction;
      const location = workspace ? findingFileLocation(finding, workspace) : null;
      if (
        task.id === "apply-feedback" &&
        workspace &&
        location &&
        target?.threadId === task.threadId &&
        target.turnId &&
        target.patchHash &&
        (!target.truncated ||
          target.anchors?.some(
            (anchor) => workspaceRelativeEvidencePath(anchor, workspace) === location.path,
          ))
      ) {
        const patches = yield* sql<{
          id: string;
          completedAt: string;
          patch: string;
          files: string;
        }>`
          SELECT file_change_id AS id, completed_at AS completedAt, patch, changed_files AS files
          FROM projection_thread_file_changes
          WHERE thread_id = ${task.threadId} AND turn_id = ${task.turnId}
            AND status = 'completed' AND completed_at IS NOT NULL
          ORDER BY completed_at DESC, last_updated_sequence DESC
        `;
        const lastChange = patches.find(({ files }) =>
          readChangedFiles(files).some(
            (path) => workspaceRelativeEvidencePath(path, workspace) === location.path,
          ),
        );
        if (lastChange && verifiesPatchCorrection(finding, excerpts, lastChange.patch, workspace))
          correction = lastChange;
        if (correction) verifiedResolution = "fixed";
      } else if (
        plan &&
        target?.threadId &&
        target.turnId &&
        ["polish", "revision-a", "revision-b"].includes(task.id)
      ) {
        const originals = yield* sql<{ markdown: string }>`
          SELECT plan_markdown AS markdown FROM projection_thread_proposed_plans
          WHERE thread_id = ${target.threadId} AND turn_id = ${target.turnId}
            AND (${target.planId ?? null} IS NULL OR plan_id = ${target.planId ?? null})
          LIMIT 2
        `;
        if (
          originals.length === 1 &&
          verifiesPlanCorrection(
            finding,
            excerpts,
            originals[0]!.markdown,
            parseWorkflowFindingOutput(plan.text, "dispositions").markdown,
          )
        )
          verifiedResolution = "fixed";
      }
    }
    let verifiedTest: StoredDisposition["verifiedTest"];
    if (
      disposition.testExecutionId &&
      disposition.testCase &&
      finding.evidence?.includes(disposition.testCase)
    ) {
      const [test] = yield* sql<{
        command: string;
        output: string;
        exitCode: number | null;
        startedAt: string;
        threadId: string;
        turnId: string;
        cwd: string | null;
      }>`
        SELECT command, output, exit_code AS exitCode, started_at AS startedAt,
          thread_id AS threadId, turn_id AS turnId, cwd
        FROM projection_thread_command_executions
        WHERE command_execution_id = ${disposition.testExecutionId}
          AND completed_at IS NOT NULL AND output_truncated = 0
          AND status IN ('completed','failed') AND exit_code IS NOT NULL
      `;
      if (
        test &&
        verifiedResolution === "fixed" &&
        correction &&
        workspace &&
        test.cwd &&
        test.threadId === task.threadId &&
        test.turnId === task.turnId &&
        test.exitCode === 0 &&
        test.startedAt > correction.completedAt &&
        isWithinEvidenceWorkspace(test.cwd, workspace) &&
        verifiesTargetedTest(test.command, test.output, disposition.testCase)
      ) {
        verifiedTest = "passed";
      } else if (
        test &&
        target &&
        test.threadId === sourceThread &&
        test.turnId === sourceTurn &&
        test.exitCode !== 0 &&
        verifiesTargetedTest(test.command, test.output, disposition.testCase, target)
      ) {
        verifiedTest = "confirmed";
      }
    }
    return {
      ...disposition,
      ...(verifiedResolution ? { verifiedResolution } : {}),
      ...(correction ? { diffFileChangeId: correction.id } : {}),
      ...(verifiedTest ? { verifiedTest } : {}),
    };
  });
}

export function materializeWorkflowBenchmark(
  sql: SqlClient.SqlClient,
  run: BenchmarkWorkflow,
  at: string,
) {
  return Effect.gen(function* () {
    const runKind = benchmarkRunKind(run);
    for (const task of benchmarkTasks(run)) {
      const kind = benchmarkOutputKind(task.id);
      if (
        !kind ||
        !task.turnId ||
        !task.threadId ||
        (task.status !== "completed" && task.id !== "polish")
      )
        continue;
      const [exists] = yield* sql`
        SELECT 1 FROM workflow_benchmark_outputs
        WHERE run_kind = ${runKind} AND workflow_id = ${run.id} AND task_id = ${task.id} AND turn_id = ${task.turnId}
      `;
      if (exists) continue;
      const attribution = yield* findWorkflowTurnAttribution(sql, task.threadId, task.turnId);
      if (
        attribution?.runKind !== runKind ||
        attribution.workflowId !== run.id ||
        attribution.taskId !== task.id
      )
        continue;
      const [message] = yield* sql<OutputSource>`
        SELECT m.message_id AS id, m.text, a.coverage, a.metadata_json AS metadata
        FROM projection_thread_messages AS m
        LEFT JOIN workflow_benchmark_artifacts AS a ON a.thread_id = m.thread_id AND a.turn_id = m.turn_id
          AND a.artifact_id = m.message_id AND a.artifact_kind = 'message' AND a.kind = ${kind}
        WHERE m.thread_id = ${task.threadId} AND m.turn_id = ${task.turnId}
          AND m.role = 'assistant' AND m.is_streaming = 0
          AND (${task.messageId ?? null} IS NULL OR m.message_id = ${task.messageId ?? null})
        ORDER BY m.created_at DESC, m.message_id DESC LIMIT 1
      `;
      const [plan] = yield* sql<OutputSource>`
        SELECT p.plan_id AS id, p.plan_markdown AS text, a.coverage, a.metadata_json AS metadata
        FROM projection_thread_proposed_plans AS p
        LEFT JOIN workflow_benchmark_artifacts AS a ON a.thread_id = p.thread_id AND a.turn_id = p.turn_id
          AND a.artifact_id = p.plan_id AND a.artifact_kind = 'plan' AND a.kind = ${kind}
        WHERE p.thread_id = ${task.threadId} AND p.turn_id = ${task.turnId}
          AND (${task.planId ?? null} IS NULL OR p.plan_id = ${task.planId ?? null})
        ORDER BY p.created_at DESC, p.plan_id DESC LIMIT 1
      `;
      if (!message && !plan) continue;
      const extract = (source: OutputSource | undefined) => {
        if (!source) return null;
        if (source.coverage)
          return { coverage: source.coverage, metadata: source.metadata, markdown: source.text };
        const parsed = parseWorkflowFindingOutput(source.text, kind);
        return {
          coverage: parsed.coverage,
          metadata: parsed.metadata ? JSON.stringify(parsed.metadata) : null,
          markdown: parsed.markdown,
        };
      };
      const planOutput = extract(plan);
      const messageOutput = extract(message);
      const planStage = task.id.startsWith("revision-") || task.id === "polish";
      const usePlan = planStage
        ? Boolean(plan)
        : selectWorkflowReport(
            task.messageId === null && planOutput?.markdown.trim() ? null : messageOutput?.markdown,
            planOutput?.markdown,
          ) === "plan";
      const output = (usePlan ? planOutput : messageOutput) ?? planOutput;
      const allowed = new Set(attribution.findingRefs);
      const metadata =
        output?.metadata && kind === "dispositions"
          ? JSON.stringify(
              yield* Effect.forEach(
                decodeDispositions(JSON.parse(output.metadata)).filter((entry) =>
                  allowed.has(entry.ref),
                ),
                (entry) =>
                  verifyFindingDisposition(
                    sql,
                    run,
                    { id: task.id, threadId: task.threadId!, turnId: task.turnId! },
                    plan,
                    {
                      ...entry,
                      ...(entry.equivalentTo
                        ? { equivalentTo: entry.equivalentTo.filter((ref) => allowed.has(ref)) }
                        : {}),
                    },
                  ),
              ),
            )
          : (output?.metadata ?? null);
      yield* sql`
        INSERT OR IGNORE INTO workflow_benchmark_outputs
          (run_kind, workflow_id, thread_id, turn_id, task_id, message_id, plan_id, kind, coverage, metadata_json, captured_at)
        VALUES (${runKind}, ${run.id}, ${task.threadId}, ${task.turnId}, ${task.id},
          ${usePlan ? null : (message?.id ?? null)},
          ${usePlan || planStage ? (plan?.id ?? null) : null}, ${kind},
          ${output?.coverage ?? "unavailable"}, ${metadata}, ${at})
      `;
    }
  });
}

export function markWorkflowBenchmarkReverted(
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  removedTurnIds: readonly string[],
  at: string,
) {
  if (!removedTurnIds.length) return Effect.void;
  return sql`
    UPDATE provider_turn_deliveries SET benchmark_reverted_at = ${at}
    WHERE thread_id = ${threadId} AND ${sql.in("provider_turn_id", removedTurnIds)}
  `.pipe(Effect.asVoid);
}
