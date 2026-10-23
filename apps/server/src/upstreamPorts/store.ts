/**
 * SQL persistence for upstream ports. Decisions and run results are recorded
 * here first (the user-acknowledged point); the publisher copies them to the
 * rolling ledger PR later.
 *
 * @module upstreamPorts/store
 */
import type {
  UpstreamOccurrenceStatus,
  UpstreamPortGroupStatus,
  UpstreamPublicationPauseReason,
  UpstreamPublicationPhase,
  UpstreamRunKind,
  UpstreamRunStatus,
  UpstreamRunSummary,
  UpstreamRunTriage,
  UpstreamRunTrigger,
} from "@t3tools/contracts";
import type { UpstreamLedgerOp } from "@t3tools/shared/upstreamPorts";
import { Data, Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export class UpstreamStoreError extends Data.TaggedError("UpstreamStoreError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Upstream ports storage failed during ${this.operation}.`;
  }
}

export type OpState = "recorded" | "merged" | "superseded" | "discarded";

export interface OpRecord {
  readonly opId: string;
  readonly projectId: string;
  readonly seq: number;
  readonly op: UpstreamLedgerOp;
  readonly state: OpState;
  readonly createdAt: string;
}

export interface PublicationRecord {
  readonly projectId: string;
  readonly branch: string | null;
  readonly prNumber: number | null;
  readonly prUrl: string | null;
  readonly prState: string | null;
  readonly lastCommitSha: string | null;
  readonly lastPushedSha: string | null;
  readonly phase: UpstreamPublicationPhase;
  readonly pausedReason: UpstreamPublicationPauseReason | null;
  readonly lastError: string | null;
  readonly lastAttemptAt: string | null;
  readonly nextAttemptAt: string | null;
  readonly attempts: number;
  readonly linksVersion: number;
}

export interface RunRecord extends UpstreamRunSummary {
  readonly projectId: string;
  readonly occurrenceDueAt: string | null;
}

export interface OccurrenceRecord {
  readonly projectId: string;
  readonly dueAt: string;
  readonly status: UpstreamOccurrenceStatus;
  readonly attempts: number;
  readonly continuations: number;
  readonly nextAttemptAt: string | null;
  readonly lastRunId: string | null;
  readonly lastError: string | null;
}

export interface PortGroupRecord {
  readonly projectId: string;
  readonly clientRequestId: string;
  readonly groupIndex: number;
  readonly threadId: string;
  readonly submissionId: string;
  readonly topicIds: ReadonlyArray<string>;
  readonly command: unknown;
  readonly status: UpstreamPortGroupStatus;
  readonly reason: string | null;
}

export interface PortLinkRecord {
  readonly projectId: string;
  readonly topicId: string;
  readonly epoch: number;
  readonly threadId: string;
  readonly clientRequestId: string;
  readonly groupIndex: number;
  readonly state: "active" | "unlinked";
}

const parseJson = <A>(value: string | null, fallback: A): A => {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as A;
  } catch {
    return fallback;
  }
};

interface OpRow {
  readonly op_id: string;
  readonly project_id: string;
  readonly seq: number;
  readonly payload_json: string;
  readonly state: OpState;
  readonly created_at: string;
}

interface PublicationRow {
  readonly project_id: string;
  readonly branch: string | null;
  readonly pr_number: number | null;
  readonly pr_url: string | null;
  readonly pr_state: string | null;
  readonly last_commit_sha: string | null;
  readonly last_pushed_sha: string | null;
  readonly phase: UpstreamPublicationPhase;
  readonly paused_reason: UpstreamPublicationPauseReason | null;
  readonly last_error: string | null;
  readonly last_attempt_at: string | null;
  readonly next_attempt_at: string | null;
  readonly attempts: number;
  readonly links_version: number;
}

interface RunRow {
  readonly run_id: string;
  readonly project_id: string;
  readonly kind: UpstreamRunKind;
  readonly trigger: UpstreamRunTrigger;
  readonly occurrence_due_at: string | null;
  readonly triage: UpstreamRunTriage;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly status: UpstreamRunStatus;
  readonly failure_kind: string | null;
  readonly target_sha: string | null;
  readonly commit_count: number;
  readonly inbox_count: number;
  readonly auto_decided_count: number;
  readonly remaining_count: number;
  readonly llm_calls: number;
  readonly error_message: string | null;
}

interface OccurrenceRow {
  readonly project_id: string;
  readonly due_at: string;
  readonly status: UpstreamOccurrenceStatus;
  readonly attempts: number;
  readonly continuations: number;
  readonly next_attempt_at: string | null;
  readonly last_run_id: string | null;
  readonly last_error: string | null;
}

interface GroupRow {
  readonly project_id: string;
  readonly client_request_id: string;
  readonly group_index: number;
  readonly thread_id: string;
  readonly submission_id: string;
  readonly topic_ids_json: string;
  readonly command_json: string;
  readonly status: UpstreamPortGroupStatus;
  readonly reason: string | null;
}

interface LinkRow {
  readonly project_id: string;
  readonly topic_id: string;
  readonly epoch: number;
  readonly thread_id: string;
  readonly client_request_id: string;
  readonly group_index: number;
  readonly state: "active" | "unlinked";
}

const toOp = (row: OpRow): OpRecord => ({
  opId: row.op_id,
  projectId: row.project_id,
  seq: Number(row.seq),
  op: JSON.parse(row.payload_json) as UpstreamLedgerOp,
  state: row.state,
  createdAt: row.created_at,
});

const toPublication = (row: PublicationRow): PublicationRecord => ({
  projectId: row.project_id,
  branch: row.branch,
  prNumber: row.pr_number === null ? null : Number(row.pr_number),
  prUrl: row.pr_url,
  prState: row.pr_state,
  lastCommitSha: row.last_commit_sha,
  lastPushedSha: row.last_pushed_sha,
  phase: row.phase,
  pausedReason: row.paused_reason,
  lastError: row.last_error,
  lastAttemptAt: row.last_attempt_at,
  nextAttemptAt: row.next_attempt_at,
  attempts: Number(row.attempts),
  linksVersion: Number(row.links_version),
});

const toRun = (row: RunRow): RunRecord => ({
  runId: row.run_id,
  projectId: row.project_id,
  kind: row.kind,
  trigger: row.trigger,
  occurrenceDueAt: row.occurrence_due_at,
  triage: row.triage,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  status: row.status,
  failureKind: row.failure_kind,
  targetSha: row.target_sha,
  commitCount: Number(row.commit_count),
  inboxCount: Number(row.inbox_count),
  autoDecidedCount: Number(row.auto_decided_count),
  remainingCount: Number(row.remaining_count),
  llmCalls: Number(row.llm_calls),
  errorMessage: row.error_message,
});

const toOccurrence = (row: OccurrenceRow): OccurrenceRecord => ({
  projectId: row.project_id,
  dueAt: row.due_at,
  status: row.status,
  attempts: Number(row.attempts),
  continuations: Number(row.continuations),
  nextAttemptAt: row.next_attempt_at,
  lastRunId: row.last_run_id,
  lastError: row.last_error,
});

const toGroup = (row: GroupRow): PortGroupRecord => ({
  projectId: row.project_id,
  clientRequestId: row.client_request_id,
  groupIndex: Number(row.group_index),
  threadId: row.thread_id,
  submissionId: row.submission_id,
  topicIds: parseJson<string[]>(row.topic_ids_json, []),
  command: parseJson<unknown>(row.command_json, null),
  status: row.status,
  reason: row.reason,
});

const toLink = (row: LinkRow): PortLinkRecord => ({
  projectId: row.project_id,
  topicId: row.topic_id,
  epoch: Number(row.epoch),
  threadId: row.thread_id,
  clientRequestId: row.client_request_id,
  groupIndex: Number(row.group_index),
  state: row.state,
});

export const DEFAULT_PUBLICATION = (projectId: string): PublicationRecord => ({
  projectId,
  branch: null,
  prNumber: null,
  prUrl: null,
  prState: null,
  lastCommitSha: null,
  lastPushedSha: null,
  phase: "idle",
  pausedReason: null,
  lastError: null,
  lastAttemptAt: null,
  nextAttemptAt: null,
  attempts: 0,
  linksVersion: 0,
});

export interface NewOp {
  readonly opId: string;
  readonly op: UpstreamLedgerOp;
}

export interface NewPortRequest {
  readonly projectId: string;
  readonly clientRequestId: string;
  readonly argsHash: string;
  readonly groups: ReadonlyArray<
    Omit<PortGroupRecord, "projectId" | "clientRequestId" | "status" | "reason">
  >;
  readonly links: ReadonlyArray<{
    readonly topicId: string;
    readonly epoch: number;
    readonly threadId: string;
    readonly groupIndex: number;
  }>;
  readonly at: string;
}

export interface UpstreamStore {
  readonly listOpenOps: (
    projectId: string,
  ) => Effect.Effect<ReadonlyArray<OpRecord>, UpstreamStoreError>;
  readonly maxSeq: (projectId: string) => Effect.Effect<number, UpstreamStoreError>;
  /** Appends ops in one transaction; a decision supersedes earlier open decisions for its topic. */
  readonly recordOps: (
    projectId: string,
    ops: ReadonlyArray<NewOp>,
    at: string,
  ) => Effect.Effect<number, UpstreamStoreError>;
  readonly setOpStates: (
    opIds: ReadonlyArray<string>,
    state: OpState,
    at: string,
  ) => Effect.Effect<void, UpstreamStoreError>;
  readonly discardOpenOps: (
    projectId: string,
    at: string,
  ) => Effect.Effect<number, UpstreamStoreError>;

  readonly getPublication: (
    projectId: string,
  ) => Effect.Effect<PublicationRecord, UpstreamStoreError>;
  readonly savePublication: (record: PublicationRecord) => Effect.Effect<void, UpstreamStoreError>;

  readonly insertRun: (run: RunRecord) => Effect.Effect<void, UpstreamStoreError>;
  readonly updateRun: (run: RunRecord) => Effect.Effect<void, UpstreamStoreError>;
  readonly latestRun: (
    projectId: string,
    filter?: { readonly finished?: boolean },
  ) => Effect.Effect<RunRecord | null, UpstreamStoreError>;
  readonly activeRun: (projectId: string) => Effect.Effect<RunRecord | null, UpstreamStoreError>;
  readonly latestSucceededUpstreamRunSince: (
    projectId: string,
    since: string,
  ) => Effect.Effect<RunRecord | null, UpstreamStoreError>;
  /** Startup recovery: runs left `running` by a previous process. */
  readonly interruptRunningRuns: (
    at: string,
  ) => Effect.Effect<ReadonlyArray<RunRecord>, UpstreamStoreError>;

  readonly getOccurrence: (
    projectId: string,
    dueAt: string,
  ) => Effect.Effect<OccurrenceRecord | null, UpstreamStoreError>;
  readonly latestOccurrence: (
    projectId: string,
  ) => Effect.Effect<OccurrenceRecord | null, UpstreamStoreError>;
  readonly saveOccurrence: (record: OccurrenceRecord) => Effect.Effect<void, UpstreamStoreError>;
  readonly supersedeOccurrencesBefore: (
    projectId: string,
    dueAt: string,
  ) => Effect.Effect<void, UpstreamStoreError>;

  readonly getPortRequest: (
    projectId: string,
    clientRequestId: string,
  ) => Effect.Effect<{ readonly argsHash: string } | null, UpstreamStoreError>;
  readonly insertPortRequest: (
    request: NewPortRequest,
  ) => Effect.Effect<boolean, UpstreamStoreError>;
  readonly listGroups: (
    projectId: string,
    clientRequestId: string,
  ) => Effect.Effect<ReadonlyArray<PortGroupRecord>, UpstreamStoreError>;
  readonly listPendingGroups: Effect.Effect<ReadonlyArray<PortGroupRecord>, UpstreamStoreError>;
  readonly setGroupStatus: (
    group: Pick<PortGroupRecord, "projectId" | "clientRequestId" | "groupIndex">,
    status: UpstreamPortGroupStatus,
    reason: string | null,
    at: string,
  ) => Effect.Effect<void, UpstreamStoreError>;
  readonly listLinks: (
    projectId: string,
  ) => Effect.Effect<ReadonlyArray<PortLinkRecord>, UpstreamStoreError>;
  readonly setLinkState: (
    link: Pick<PortLinkRecord, "projectId" | "topicId" | "threadId">,
    state: "active" | "unlinked",
    filter?: { readonly clientRequestId: string; readonly groupIndex: number },
  ) => Effect.Effect<void, UpstreamStoreError>;
}

export function makeUpstreamStore(sql: SqlClient.SqlClient): UpstreamStore {
  const fail = (operation: string) => (cause: unknown) =>
    new UpstreamStoreError({ operation, cause });

  const listOpenOps: UpstreamStore["listOpenOps"] = (projectId) =>
    sql<OpRow>`SELECT op_id, project_id, seq, payload_json, state, created_at
      FROM upstream_ledger_ops WHERE project_id = ${projectId} AND state = 'recorded'
      ORDER BY seq`.pipe(
      Effect.map((rows) => rows.map(toOp)),
      Effect.mapError(fail("listOpenOps")),
    );

  const maxSeq: UpstreamStore["maxSeq"] = (projectId) =>
    sql<{ readonly seq: number | null }>`SELECT MAX(seq) AS seq FROM upstream_ledger_ops
      WHERE project_id = ${projectId}`.pipe(
      Effect.map((rows) => Number(rows[0]?.seq ?? 0)),
      Effect.mapError(fail("maxSeq")),
    );

  const recordOps: UpstreamStore["recordOps"] = (projectId, ops, at) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          let seq = Number(
            (yield* sql<{ readonly seq: number | null }>`SELECT MAX(seq) AS seq
              FROM upstream_ledger_ops WHERE project_id = ${projectId}`)[0]?.seq ?? 0,
          );
          for (const { opId, op } of ops) {
            seq += 1;
            const target =
              op.kind === "decision"
                ? op.topicId
                : op.kind === "interval"
                  ? `interval:${op.file.interval}`
                  : `legacy:${op.file.batch}`;
            if (op.kind === "decision")
              yield* sql`UPDATE upstream_ledger_ops SET state = 'superseded', updated_at = ${at}
                WHERE project_id = ${projectId} AND kind = 'decision' AND target = ${target}
                  AND state = 'recorded'`;
            yield* sql`INSERT INTO upstream_ledger_ops
              (op_id, project_id, seq, kind, target, payload_json, state, created_at, updated_at)
              VALUES (${opId}, ${projectId}, ${seq}, ${op.kind}, ${target}, ${JSON.stringify(op)},
                'recorded', ${at}, ${at})`;
          }
          return seq;
        }),
      )
      .pipe(Effect.mapError(fail("recordOps")));

  const setOpStates: UpstreamStore["setOpStates"] = (opIds, state, at) =>
    opIds.length === 0
      ? Effect.void
      : sql`UPDATE upstream_ledger_ops SET state = ${state}, updated_at = ${at}
          WHERE ${sql.in("op_id", opIds)}`.pipe(
          Effect.asVoid,
          Effect.mapError(fail("setOpStates")),
        );

  const discardOpenOps: UpstreamStore["discardOpenOps"] = (projectId, at) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n
            FROM upstream_ledger_ops WHERE project_id = ${projectId} AND state = 'recorded'`;
          yield* sql`UPDATE upstream_ledger_ops SET state = 'discarded', updated_at = ${at}
            WHERE project_id = ${projectId} AND state = 'recorded'`;
          return Number(rows[0]?.n ?? 0);
        }),
      )
      .pipe(Effect.mapError(fail("discardOpenOps")));

  const getPublication: UpstreamStore["getPublication"] = (projectId) =>
    sql<PublicationRow>`SELECT * FROM upstream_ledger_publication WHERE project_id = ${projectId}`.pipe(
      Effect.map((rows) => (rows[0] ? toPublication(rows[0]) : DEFAULT_PUBLICATION(projectId))),
      Effect.mapError(fail("getPublication")),
    );

  const savePublication: UpstreamStore["savePublication"] = (r) =>
    sql`INSERT INTO upstream_ledger_publication (project_id, branch, pr_number, pr_url, pr_state,
        last_commit_sha, last_pushed_sha, phase, paused_reason, last_error, last_attempt_at,
        next_attempt_at, attempts, links_version)
      VALUES (${r.projectId}, ${r.branch}, ${r.prNumber}, ${r.prUrl}, ${r.prState},
        ${r.lastCommitSha}, ${r.lastPushedSha}, ${r.phase}, ${r.pausedReason}, ${r.lastError},
        ${r.lastAttemptAt}, ${r.nextAttemptAt}, ${r.attempts}, ${r.linksVersion})
      ON CONFLICT (project_id) DO UPDATE SET branch = excluded.branch,
        pr_number = excluded.pr_number, pr_url = excluded.pr_url, pr_state = excluded.pr_state,
        last_commit_sha = excluded.last_commit_sha, last_pushed_sha = excluded.last_pushed_sha,
        phase = excluded.phase, paused_reason = excluded.paused_reason,
        last_error = excluded.last_error, last_attempt_at = excluded.last_attempt_at,
        next_attempt_at = excluded.next_attempt_at, attempts = excluded.attempts`.pipe(
      Effect.asVoid,
      Effect.mapError(fail("savePublication")),
    );

  const insertRun: UpstreamStore["insertRun"] = (r) =>
    sql`INSERT INTO upstream_port_runs (run_id, project_id, kind, trigger, occurrence_due_at, triage,
        started_at, finished_at, status, failure_kind, target_sha, commit_count, inbox_count,
        auto_decided_count, remaining_count, llm_calls, error_message)
      VALUES (${r.runId}, ${r.projectId}, ${r.kind}, ${r.trigger}, ${r.occurrenceDueAt}, ${r.triage},
        ${r.startedAt}, ${r.finishedAt}, ${r.status}, ${r.failureKind}, ${r.targetSha},
        ${r.commitCount}, ${r.inboxCount}, ${r.autoDecidedCount}, ${r.remainingCount},
        ${r.llmCalls}, ${r.errorMessage})`.pipe(Effect.asVoid, Effect.mapError(fail("insertRun")));

  const updateRun: UpstreamStore["updateRun"] = (r) =>
    sql`UPDATE upstream_port_runs SET finished_at = ${r.finishedAt}, status = ${r.status},
        failure_kind = ${r.failureKind}, target_sha = ${r.targetSha}, commit_count = ${r.commitCount},
        inbox_count = ${r.inboxCount}, auto_decided_count = ${r.autoDecidedCount},
        remaining_count = ${r.remainingCount}, llm_calls = ${r.llmCalls},
        error_message = ${r.errorMessage}
      WHERE run_id = ${r.runId}`.pipe(Effect.asVoid, Effect.mapError(fail("updateRun")));

  const latestRun: UpstreamStore["latestRun"] = (projectId, filter) =>
    (filter?.finished
      ? sql<RunRow>`SELECT * FROM upstream_port_runs WHERE project_id = ${projectId}
          AND status != 'running' ORDER BY started_at DESC, run_id DESC LIMIT 1`
      : sql<RunRow>`SELECT * FROM upstream_port_runs WHERE project_id = ${projectId}
          ORDER BY started_at DESC, run_id DESC LIMIT 1`
    ).pipe(
      Effect.map((rows) => (rows[0] ? toRun(rows[0]) : null)),
      Effect.mapError(fail("latestRun")),
    );

  const activeRun: UpstreamStore["activeRun"] = (projectId) =>
    sql<RunRow>`SELECT * FROM upstream_port_runs WHERE project_id = ${projectId}
      AND status = 'running' ORDER BY started_at DESC LIMIT 1`.pipe(
      Effect.map((rows) => (rows[0] ? toRun(rows[0]) : null)),
      Effect.mapError(fail("activeRun")),
    );

  const latestSucceededUpstreamRunSince: UpstreamStore["latestSucceededUpstreamRunSince"] = (
    projectId,
    since,
  ) =>
    sql<RunRow>`SELECT * FROM upstream_port_runs WHERE project_id = ${projectId}
      AND kind = 'upstream' AND status = 'succeeded' AND started_at >= ${since}
      ORDER BY started_at DESC LIMIT 1`.pipe(
      Effect.map((rows) => (rows[0] ? toRun(rows[0]) : null)),
      Effect.mapError(fail("latestSucceededUpstreamRunSince")),
    );

  const interruptRunningRuns: UpstreamStore["interruptRunningRuns"] = (at) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows =
            yield* sql<RunRow>`SELECT * FROM upstream_port_runs WHERE status = 'running'`;
          yield* sql`UPDATE upstream_port_runs SET status = 'interrupted', finished_at = ${at},
            failure_kind = 'interrupted' WHERE status = 'running'`;
          return rows.map(toRun);
        }),
      )
      .pipe(Effect.mapError(fail("interruptRunningRuns")));

  const getOccurrence: UpstreamStore["getOccurrence"] = (projectId, dueAt) =>
    sql<OccurrenceRow>`SELECT * FROM upstream_port_occurrences
      WHERE project_id = ${projectId} AND due_at = ${dueAt}`.pipe(
      Effect.map((rows) => (rows[0] ? toOccurrence(rows[0]) : null)),
      Effect.mapError(fail("getOccurrence")),
    );

  const latestOccurrence: UpstreamStore["latestOccurrence"] = (projectId) =>
    sql<OccurrenceRow>`SELECT * FROM upstream_port_occurrences WHERE project_id = ${projectId}
      ORDER BY due_at DESC LIMIT 1`.pipe(
      Effect.map((rows) => (rows[0] ? toOccurrence(rows[0]) : null)),
      Effect.mapError(fail("latestOccurrence")),
    );

  const saveOccurrence: UpstreamStore["saveOccurrence"] = (o) =>
    sql`INSERT INTO upstream_port_occurrences (project_id, due_at, status, attempts, continuations,
        next_attempt_at, last_run_id, last_error)
      VALUES (${o.projectId}, ${o.dueAt}, ${o.status}, ${o.attempts}, ${o.continuations},
        ${o.nextAttemptAt}, ${o.lastRunId}, ${o.lastError})
      ON CONFLICT (project_id, due_at) DO UPDATE SET status = excluded.status,
        attempts = excluded.attempts, continuations = excluded.continuations,
        next_attempt_at = excluded.next_attempt_at, last_run_id = excluded.last_run_id,
        last_error = excluded.last_error`.pipe(
      Effect.asVoid,
      Effect.mapError(fail("saveOccurrence")),
    );

  const supersedeOccurrencesBefore: UpstreamStore["supersedeOccurrencesBefore"] = (
    projectId,
    dueAt,
  ) =>
    sql`UPDATE upstream_port_occurrences SET status = 'superseded'
      WHERE project_id = ${projectId} AND due_at < ${dueAt}
        AND status IN ('pending', 'running')`.pipe(
      Effect.asVoid,
      Effect.mapError(fail("supersedeOccurrencesBefore")),
    );

  const getPortRequest: UpstreamStore["getPortRequest"] = (projectId, clientRequestId) =>
    sql<{ readonly args_hash: string }>`SELECT args_hash FROM upstream_port_requests
      WHERE project_id = ${projectId} AND client_request_id = ${clientRequestId}`.pipe(
      Effect.map((rows) => (rows[0] ? { argsHash: rows[0].args_hash } : null)),
      Effect.mapError(fail("getPortRequest")),
    );

  const insertPortRequest: UpstreamStore["insertPortRequest"] = (request) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* sql`SELECT 1 FROM upstream_port_requests
            WHERE project_id = ${request.projectId}
              AND client_request_id = ${request.clientRequestId}`;
          if (existing.length > 0) return false;
          yield* sql`INSERT INTO upstream_port_requests (project_id, client_request_id, args_hash, created_at)
            VALUES (${request.projectId}, ${request.clientRequestId}, ${request.argsHash}, ${request.at})`;
          for (const group of request.groups)
            yield* sql`INSERT INTO upstream_port_groups (project_id, client_request_id, group_index,
                thread_id, submission_id, topic_ids_json, command_json, status, reason, updated_at)
              VALUES (${request.projectId}, ${request.clientRequestId}, ${group.groupIndex},
                ${group.threadId}, ${group.submissionId}, ${JSON.stringify(group.topicIds)},
                ${JSON.stringify(group.command)}, 'pending', NULL, ${request.at})`;
          for (const link of request.links)
            yield* sql`INSERT OR REPLACE INTO upstream_port_links (project_id, topic_id, epoch,
                thread_id, client_request_id, group_index, state)
              VALUES (${request.projectId}, ${link.topicId}, ${link.epoch}, ${link.threadId},
                ${request.clientRequestId}, ${link.groupIndex}, 'active')`;
          yield* sql`INSERT INTO upstream_ledger_publication (project_id, links_version)
            VALUES (${request.projectId}, 1)
            ON CONFLICT (project_id) DO UPDATE SET links_version = links_version + 1`;
          return true;
        }),
      )
      .pipe(Effect.mapError(fail("insertPortRequest")));

  const listGroups: UpstreamStore["listGroups"] = (projectId, clientRequestId) =>
    sql<GroupRow>`SELECT * FROM upstream_port_groups WHERE project_id = ${projectId}
      AND client_request_id = ${clientRequestId} ORDER BY group_index`.pipe(
      Effect.map((rows) => rows.map(toGroup)),
      Effect.mapError(fail("listGroups")),
    );

  const listPendingGroups: UpstreamStore["listPendingGroups"] = sql<GroupRow>`SELECT *
    FROM upstream_port_groups WHERE status = 'pending' ORDER BY updated_at, group_index`.pipe(
    Effect.map((rows) => rows.map(toGroup)),
    Effect.mapError(fail("listPendingGroups")),
  );

  const setGroupStatus: UpstreamStore["setGroupStatus"] = (group, status, reason, at) =>
    sql`UPDATE upstream_port_groups SET status = ${status}, reason = ${reason}, updated_at = ${at}
      WHERE project_id = ${group.projectId} AND client_request_id = ${group.clientRequestId}
        AND group_index = ${group.groupIndex}`.pipe(
      Effect.asVoid,
      Effect.mapError(fail("setGroupStatus")),
    );

  const listLinks: UpstreamStore["listLinks"] = (projectId) =>
    sql<LinkRow>`SELECT * FROM upstream_port_links WHERE project_id = ${projectId}`.pipe(
      Effect.map((rows) => rows.map(toLink)),
      Effect.mapError(fail("listLinks")),
    );

  const setLinkState: UpstreamStore["setLinkState"] = (link, state, filter) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          if (filter)
            yield* sql`UPDATE upstream_port_links SET state = ${state}
              WHERE project_id = ${link.projectId} AND client_request_id = ${filter.clientRequestId}
                AND group_index = ${filter.groupIndex}`;
          else
            yield* sql`UPDATE upstream_port_links SET state = ${state}
              WHERE project_id = ${link.projectId} AND topic_id = ${link.topicId}
                AND thread_id = ${link.threadId}`;
          yield* sql`INSERT INTO upstream_ledger_publication (project_id, links_version)
            VALUES (${link.projectId}, 1)
            ON CONFLICT (project_id) DO UPDATE SET links_version = links_version + 1`;
        }),
      )
      .pipe(Effect.mapError(fail("setLinkState")));

  return {
    listOpenOps,
    maxSeq,
    recordOps,
    setOpStates,
    discardOpenOps,
    getPublication,
    savePublication,
    insertRun,
    updateRun,
    latestRun,
    activeRun,
    latestSucceededUpstreamRunSince,
    interruptRunningRuns,
    getOccurrence,
    latestOccurrence,
    saveOccurrence,
    supersedeOccurrencesBefore,
    getPortRequest,
    insertPortRequest,
    listGroups,
    listPendingGroups,
    setGroupStatus,
    listLinks,
    setLinkState,
  };
}
