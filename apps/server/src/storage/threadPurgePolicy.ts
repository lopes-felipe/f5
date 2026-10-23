import type { ThreadId, CommandId } from "@t3tools/contracts";
import { Data, Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
export class ScheduledThreadPurgeBlocked extends Data.TaggedError("ScheduledThreadPurgeBlocked")<{
  readonly threadId: ThreadId;
  readonly message: string;
}> {}
export const assertScheduledThreadPurgeable = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  Effect.gen(function* () {
    const owners =
      yield* sql`SELECT id FROM scheduled_task_runs WHERE thread_id=${threadId} AND owns_execution=1 LIMIT 1`;
    if (owners.length)
      return yield* new ScheduledThreadPurgeBlocked({
        threadId,
        message: "Resolve the scheduled run before purging its execution evidence.",
      });
  });

/** Every durable thread reference must have an explicit retention decision. */
export const threadPurgePolicy: Readonly<
  Record<
    string,
    { readonly kind: "root" | "cascade" | "explicit" | "retain"; readonly reason?: string }
  >
> = {
  scheduled_task_quarantine: {
    kind: "retain",
    reason: "Malformed scheduled execution evidence requires explicit recovery.",
  },
  scheduled_task_runs: {
    kind: "retain",
    reason: "Scheduled execution ownership and bounded history survive thread purge.",
  },
  scheduled_run_submissions: {
    kind: "retain",
    reason: "Delivery associations must remain fenced after thread purge.",
  },
  scheduled_notifications: {
    kind: "retain",
    reason: "Durable notification intent has independent retention.",
  },
  thread_pull_request_watches: { kind: "cascade" },
  thread_pull_request_watch_stops: { kind: "cascade" },
  thread_message_authorship: { kind: "cascade" },
  thread_settlement_requests: { kind: "cascade" },
  thread_settlement_hooks: { kind: "cascade" },
  mcp_app_instances: { kind: "cascade" },
  mcp_app_model_context: { kind: "cascade" },
  search_documents: { kind: "explicit" },
  usage_limit_resumes: { kind: "cascade" },
  usage_limit_resume_streaks: { kind: "cascade" },
  pr_hub_reply_drafts: { kind: "explicit" },
  projection_thread_pull_requests: { kind: "cascade" },
  restart_turn_markers: { kind: "cascade" },
  restart_continuations: { kind: "cascade" },
  agent_bridge_requests: {
    kind: "retain",
    reason: "Bridge idempotency receipts survive source thread deletion.",
  },
  projection_threads: { kind: "root" },
  checkpoint_diff_blobs: { kind: "explicit" },
  provider_session_runtime: { kind: "explicit" },
  orchestration_event_compaction: { kind: "explicit" },
  provider_submission_provenance: { kind: "explicit" },
  provider_terminal_events: { kind: "explicit" },
  provider_turn_deliveries: { kind: "explicit" },
  native_operations: { kind: "explicit" },
  native_history_retired_turns: { kind: "explicit" },
  workspace_transitions: { kind: "explicit" },
  worktree_setup_ordering: { kind: "explicit" },
  next_turn_queue_orphaned_attachments: { kind: "explicit" },
  next_turn_queue_quarantine: { kind: "explicit" },
  projection_turn_usage_facts: { kind: "explicit" },
  projection_thread_messages: { kind: "explicit" },
  projection_thread_activities: { kind: "explicit" },
  projection_thread_command_executions: { kind: "explicit" },
  projection_thread_file_changes: { kind: "explicit" },
  projection_thread_proposed_plans: { kind: "explicit" },
  projection_thread_sessions: { kind: "explicit" },
  projection_pending_approvals: { kind: "explicit" },
  projection_turns: { kind: "explicit" },
  attachments: { kind: "cascade" },
  next_turn_queue: { kind: "cascade" },
  next_turn_queue_state: { kind: "cascade" },
  turn_submissions: { kind: "cascade" },
  rewind_operations: { kind: "cascade" },
  rewind_requests: { kind: "cascade" },
  projection_thread_pin_state: { kind: "cascade" },
  projection_thread_background_work: { kind: "cascade" },
  projection_pending_user_inputs: { kind: "cascade" },
  storage_automation_audit: {
    kind: "retain",
    reason: "Bounded historical audit, pruned after 90 days or 5,000 records.",
  },
  agent_bridge_threads: {
    kind: "retain",
    reason: "Bridge idempotency receipts must survive thread deletion.",
  },
  upstream_port_groups: {
    kind: "retain",
    reason: "Start-port idempotency receipts must survive thread deletion.",
  },
  upstream_port_links: { kind: "explicit" },
};

/** Static SQL handlers; schema introspection must never determine what gets deleted. */
export const threadPurgeHandlers = {
  native_history_retired_turns: (sql: SqlClient.SqlClient, threadId: ThreadId) =>
    sql`DELETE FROM native_history_retired_turns WHERE rowid IN (SELECT rowid FROM native_history_retired_turns WHERE thread_id = ${threadId} LIMIT 500) RETURNING rowid`,
  checkpoint_diff_blobs: (sql: SqlClient.SqlClient, threadId: ThreadId) =>
    sql`DELETE FROM checkpoint_diff_blobs WHERE rowid IN (SELECT rowid FROM checkpoint_diff_blobs WHERE thread_id = ${threadId} LIMIT 500) RETURNING rowid`,
  projection_thread_messages: (sql: SqlClient.SqlClient, threadId: ThreadId) =>
    sql`DELETE FROM projection_thread_messages WHERE rowid IN (SELECT rowid FROM projection_thread_messages WHERE thread_id = ${threadId} LIMIT 500) RETURNING rowid`,
  projection_thread_activities: (sql: SqlClient.SqlClient, threadId: ThreadId) =>
    sql`DELETE FROM projection_thread_activities WHERE rowid IN (SELECT rowid FROM projection_thread_activities WHERE thread_id = ${threadId} LIMIT 500) RETURNING rowid`,
  projection_thread_command_executions: (sql: SqlClient.SqlClient, threadId: ThreadId) =>
    sql`DELETE FROM projection_thread_command_executions WHERE rowid IN (SELECT rowid FROM projection_thread_command_executions WHERE thread_id = ${threadId} LIMIT 500) RETURNING rowid`,
  projection_thread_file_changes: (sql: SqlClient.SqlClient, threadId: ThreadId) =>
    sql`DELETE FROM projection_thread_file_changes WHERE rowid IN (SELECT rowid FROM projection_thread_file_changes WHERE thread_id = ${threadId} LIMIT 500) RETURNING rowid`,
  projection_thread_proposed_plans: (sql: SqlClient.SqlClient, threadId: ThreadId) =>
    sql`DELETE FROM projection_thread_proposed_plans WHERE rowid IN (SELECT rowid FROM projection_thread_proposed_plans WHERE thread_id = ${threadId} LIMIT 500) RETURNING rowid`,
  projection_thread_sessions: (sql: SqlClient.SqlClient, threadId: ThreadId) =>
    sql`DELETE FROM projection_thread_sessions WHERE rowid IN (SELECT rowid FROM projection_thread_sessions WHERE thread_id = ${threadId} LIMIT 500) RETURNING rowid`,
  projection_pending_approvals: (sql: SqlClient.SqlClient, threadId: ThreadId) =>
    sql`DELETE FROM projection_pending_approvals WHERE rowid IN (SELECT rowid FROM projection_pending_approvals WHERE thread_id = ${threadId} LIMIT 500) RETURNING rowid`,
  projection_turns: (sql: SqlClient.SqlClient, threadId: ThreadId) =>
    sql`DELETE FROM projection_turns WHERE rowid IN (SELECT rowid FROM projection_turns WHERE thread_id = ${threadId} LIMIT 500) RETURNING rowid`,
  projection_turn_usage_facts: (sql: SqlClient.SqlClient, threadId: ThreadId) =>
    sql`DELETE FROM projection_turn_usage_facts WHERE rowid IN (SELECT rowid FROM projection_turn_usage_facts WHERE thread_id = ${threadId} LIMIT 500) RETURNING rowid`,
  provider_session_runtime: (sql: SqlClient.SqlClient, threadId: ThreadId) =>
    sql`DELETE FROM provider_session_runtime WHERE rowid IN (SELECT rowid FROM provider_session_runtime WHERE thread_id = ${threadId} LIMIT 500) RETURNING rowid`,
  orchestration_event_compaction: (sql: SqlClient.SqlClient, threadId: ThreadId) =>
    sql`DELETE FROM orchestration_event_compaction WHERE rowid IN (SELECT rowid FROM orchestration_event_compaction WHERE thread_id = ${threadId} LIMIT 500) RETURNING rowid`,
  search_documents: (sql: SqlClient.SqlClient, threadId: ThreadId) =>
    sql`DELETE FROM search_documents WHERE rowid IN (SELECT rowid FROM search_documents WHERE thread_id = ${threadId} LIMIT 500) RETURNING rowid`,
  pr_hub_reply_drafts: (sql: SqlClient.SqlClient, threadId: ThreadId) =>
    sql`DELETE FROM pr_hub_reply_drafts WHERE rowid IN (SELECT rowid FROM pr_hub_reply_drafts WHERE thread_id = ${threadId} LIMIT 500) RETURNING rowid`,
  provider_submission_provenance: (sql: SqlClient.SqlClient, threadId: ThreadId) =>
    sql`DELETE FROM provider_submission_provenance WHERE rowid IN (SELECT rowid FROM provider_submission_provenance WHERE thread_id = ${threadId} LIMIT 500) RETURNING rowid`,
  next_turn_queue_orphaned_attachments: (sql: SqlClient.SqlClient, threadId: ThreadId) =>
    sql`DELETE FROM next_turn_queue_orphaned_attachments WHERE rowid IN (SELECT rowid FROM next_turn_queue_orphaned_attachments WHERE thread_id = ${threadId} LIMIT 500) RETURNING rowid`,
  next_turn_queue_quarantine: (sql: SqlClient.SqlClient, threadId: ThreadId) =>
    sql`DELETE FROM next_turn_queue_quarantine WHERE rowid IN (SELECT rowid FROM next_turn_queue_quarantine WHERE thread_id = ${threadId} LIMIT 500) RETURNING rowid`,
  worktree_setup_ordering: (sql: SqlClient.SqlClient, threadId: ThreadId) =>
    sql`DELETE FROM worktree_setup_ordering WHERE rowid IN (SELECT rowid FROM worktree_setup_ordering WHERE thread_id = ${threadId} LIMIT 500) RETURNING rowid`,
  provider_terminal_events: (sql: SqlClient.SqlClient, threadId: ThreadId) =>
    sql`DELETE FROM provider_terminal_events WHERE rowid IN (SELECT rowid FROM provider_terminal_events WHERE thread_id = ${threadId} LIMIT 500) RETURNING rowid`,
  provider_turn_deliveries: (sql: SqlClient.SqlClient, threadId: ThreadId) =>
    sql`DELETE FROM provider_turn_deliveries WHERE rowid IN (SELECT rowid FROM provider_turn_deliveries WHERE thread_id = ${threadId} LIMIT 500) RETURNING rowid`,
  native_operations: (sql: SqlClient.SqlClient, threadId: ThreadId) =>
    sql`DELETE FROM native_operations WHERE rowid IN (SELECT rowid FROM native_operations WHERE thread_id = ${threadId} LIMIT 500) RETURNING rowid`,
  workspace_transitions: (sql: SqlClient.SqlClient, threadId: ThreadId) =>
    sql`DELETE FROM workspace_transitions WHERE rowid IN (SELECT rowid FROM workspace_transitions WHERE thread_id = ${threadId} LIMIT 500) RETURNING rowid`,
  // A deleted port thread no longer holds its topics in progress; the version bump invalidates cursors.
  upstream_port_links: (sql: SqlClient.SqlClient, threadId: ThreadId) =>
    sql`UPDATE upstream_ledger_publication SET links_version = links_version + 1 WHERE project_id IN (SELECT project_id FROM upstream_port_links WHERE thread_id = ${threadId})`.pipe(
      Effect.andThen(
        sql`DELETE FROM upstream_port_links WHERE rowid IN (SELECT rowid FROM upstream_port_links WHERE thread_id = ${threadId} LIMIT 500) RETURNING rowid`,
      ),
    ),
};
export const purgeThreadRows = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  coverageResumesAt: string,
  commandIds: ReadonlyArray<CommandId>,
) =>
  Effect.gen(function* () {
    const drain = <E>(statement: Effect.Effect<ReadonlyArray<unknown>, E>) =>
      Effect.gen(function* () {
        for (;;) {
          const rows = yield* statement;
          if (rows.length < 500) return;
          yield* Effect.yieldNow;
        }
      });
    yield* assertScheduledThreadPurgeable(sql, threadId);
    for (const handler of Object.values(threadPurgeHandlers)) yield* drain(handler(sql, threadId));
    yield* sql`DELETE FROM attachment_owners WHERE owner_kind = 'activity' AND attachment_id IN (SELECT attachment_id FROM attachments WHERE thread_id = ${threadId})`;
    yield* sql`UPDATE projection_usage_metadata SET coverage_started_at = CASE WHEN coverage_started_at < ${coverageResumesAt} THEN ${coverageResumesAt} ELSE coverage_started_at END WHERE singleton_id = 1`;
    for (const commandId of commandIds)
      yield* sql`DELETE FROM orchestration_command_receipts WHERE command_id = ${commandId}`;
    yield* drain(
      sql`DELETE FROM orchestration_events WHERE rowid IN (SELECT rowid FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ${threadId} LIMIT 500) RETURNING rowid`,
    );
    // Verified cascades execute here; retained filesystem receipts have no cascade.
    yield* sql`DELETE FROM projection_threads WHERE thread_id = ${threadId}`;
  });
