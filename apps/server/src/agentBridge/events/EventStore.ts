/**
 * SQL persistence for Agent Bridge MCP Events: subscriptions, delivery state,
 * verified callbacks, and delivery diagnostics.
 *
 * @module agentBridge/events/EventStore
 */
import type { AgentBridgeClientReadiness } from "@t3tools/contracts";
import { Data, Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export const SUBSCRIPTION_LEASE_MS = 30_000;
export const VERIFIED_CALLBACK_TTL_MS = 24 * 60 * 60 * 1000;
export const DELIVERY_DIAGNOSTICS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_SUBSCRIPTIONS_PER_CLIENT = 8;

export class EventStoreError extends Data.TaggedError("EventStoreError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Agent Bridge event storage failed during ${this.operation}.`;
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

/** An event serialized once and retried verbatim until it is delivered or skipped. */
export interface PendingEvent {
  readonly eventId: string;
  readonly name: string;
  readonly body: string;
  /** Watermarks to store once this event is settled. */
  readonly eventWatermark: number;
  readonly taskWatermark: number;
  /** True when this is the backlog event (clears `backlog_pending`). */
  readonly backlog: boolean;
  /** Task or thread the event concerns; access is rechecked before each attempt. */
  readonly subject: { readonly kind: "thread" | "task" | "client"; readonly id: string };
}

export interface SubscriptionRecord {
  readonly id: string;
  readonly clientId: string;
  readonly tokenFamilyId: string;
  readonly grantGeneration: number;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly url: string;
  readonly secretRef: string;
  readonly previousSecretRef: string | null;
  readonly previousSecretUntil: string | null;
  readonly status: "active" | "delivery-failed";
  readonly eventWatermark: number;
  readonly taskWatermark: number;
  readonly backlogPending: boolean;
  readonly pendingEvent: PendingEvent | null;
  readonly attempt: number;
  readonly nextAttemptAt: string | null;
  readonly lastDeliveredAt: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
}

interface SubscriptionRow {
  readonly id: string;
  readonly client_id: string;
  readonly token_family_id: string;
  readonly grant_generation: number;
  readonly name: string;
  readonly arguments_json: string;
  readonly url: string;
  readonly secret_ref: string;
  readonly previous_secret_ref: string | null;
  readonly previous_secret_until: string | null;
  readonly status: "active" | "delivery-failed";
  readonly event_watermark: number;
  readonly task_watermark: number;
  readonly backlog_pending: number;
  readonly pending_event_json: string | null;
  readonly attempt: number;
  readonly next_attempt_at: string | null;
  readonly last_delivered_at: string | null;
  readonly expires_at: string;
  readonly created_at: string;
}

const toSubscription = (row: SubscriptionRow): SubscriptionRecord => ({
  id: row.id,
  clientId: row.client_id,
  tokenFamilyId: row.token_family_id,
  grantGeneration: row.grant_generation,
  name: row.name,
  arguments: JSON.parse(row.arguments_json) as Record<string, unknown>,
  url: row.url,
  secretRef: row.secret_ref,
  previousSecretRef: row.previous_secret_ref,
  previousSecretUntil: row.previous_secret_until,
  status: row.status,
  eventWatermark: row.event_watermark,
  taskWatermark: row.task_watermark,
  backlogPending: row.backlog_pending === 1,
  pendingEvent: row.pending_event_json
    ? (JSON.parse(row.pending_event_json) as PendingEvent)
    : null,
  attempt: row.attempt,
  nextAttemptAt: row.next_attempt_at,
  lastDeliveredAt: row.last_delivered_at,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
});

export interface TaskActivityRow {
  readonly taskId: string;
  readonly revision: number;
  readonly sequence: number;
  readonly type: string;
  readonly actor: "bot" | "operator";
  readonly questionId: string | null;
  readonly status: string;
  readonly title: string;
  readonly projectId: string;
}

export interface EventStore {
  readonly get: (id: string) => Effect.Effect<SubscriptionRecord | null, EventStoreError>;
  readonly listForClient: (
    clientId: string,
  ) => Effect.Effect<ReadonlyArray<SubscriptionRecord>, EventStoreError>;
  /** Due subscriptions: unexpired, not leased, with no retry scheduled in the future. */
  readonly listDue: (
    at: number,
  ) => Effect.Effect<ReadonlyArray<SubscriptionRecord>, EventStoreError>;
  /** Creates or refreshes a subscription. On refresh a changed secret keeps the old one for 24 h. */
  readonly upsert: (input: {
    readonly id: string;
    readonly clientId: string;
    readonly tokenFamilyId: string;
    readonly grantGeneration: number;
    readonly name: string;
    readonly arguments: Record<string, unknown>;
    readonly url: string;
    readonly secretRef: string;
    readonly expiresAt: string;
    readonly eventWatermark: number;
    readonly taskWatermark: number;
    readonly backlog: boolean;
    readonly at: number;
  }) => Effect.Effect<
    { readonly created: boolean; readonly replacedSecretRef: string | null },
    EventStoreError
  >;
  readonly countForClient: (clientId: string) => Effect.Effect<number, EventStoreError>;
  /** Deletes a subscription; returns its secret references for cleanup. */
  readonly remove: (id: string) => Effect.Effect<ReadonlyArray<string>, EventStoreError>;
  /** Deletes every subscription (the issuer changed); returns secret references. */
  readonly removeAll: Effect.Effect<ReadonlyArray<string>, EventStoreError>;
  readonly removeForClient: (
    clientId: string,
  ) => Effect.Effect<ReadonlyArray<string>, EventStoreError>;
  /** Claims a 30 s lease; false when another worker holds it. */
  readonly claim: (id: string, at: number) => Effect.Effect<boolean, EventStoreError>;
  readonly release: (id: string) => Effect.Effect<void, EventStoreError>;
  readonly setPendingEvent: (
    id: string,
    event: PendingEvent,
  ) => Effect.Effect<void, EventStoreError>;
  /** Advances watermarks without delivering (events this subscription does not want). */
  readonly advance: (
    id: string,
    watermarks: { readonly eventWatermark: number; readonly taskWatermark: number },
  ) => Effect.Effect<void, EventStoreError>;
  /** The pending event was delivered (or skipped): store its watermarks and clear retry state. */
  readonly settle: (
    id: string,
    event: PendingEvent,
    outcome: {
      readonly delivered: boolean;
      readonly at: number;
      readonly lastStatus: number | null;
      readonly attempts: number;
    },
  ) => Effect.Effect<void, EventStoreError>;
  readonly scheduleRetry: (
    id: string,
    input: { readonly attempt: number; readonly nextAttemptAt: number; readonly error: string },
  ) => Effect.Effect<void, EventStoreError>;
  /** Drops the pending event without delivering it (its subject is no longer accessible). */
  readonly dropPending: (id: string, event: PendingEvent) => Effect.Effect<void, EventStoreError>;
  /** The earliest scheduled retry, if any. */
  readonly nextDueAt: Effect.Effect<number | null, EventStoreError>;
  readonly recordGone: (
    id: string,
    event: PendingEvent | null,
    at: number,
  ) => Effect.Effect<void, EventStoreError>;
  /** Requests a backlog event on the client's subscriptions and makes them due now. */
  readonly requestBacklog: (clientId: string) => Effect.Effect<number, EventStoreError>;
  readonly isCallbackVerified: (
    clientId: string,
    url: string,
    at: number,
  ) => Effect.Effect<boolean, EventStoreError>;
  readonly markCallbackVerified: (
    clientId: string,
    url: string,
    at: number,
  ) => Effect.Effect<void, EventStoreError>;
  /** Whether the token family still has a live, unrevoked token. */
  readonly isFamilyActive: (
    familyId: string,
    at: number,
  ) => Effect.Effect<boolean, EventStoreError>;
  readonly currentTaskRevision: Effect.Effect<number, EventStoreError>;
  /** Task activities after a revision for one client's tasks, oldest first. */
  readonly taskActivitiesAfter: (
    clientId: string,
    revision: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<TaskActivityRow>, EventStoreError>;
  /** The task's project when it is assigned to this client. */
  readonly taskProject: (
    taskId: string,
    clientId: string,
  ) => Effect.Effect<string | null, EventStoreError>;
  /** Queued tasks and tasks with an unanswered update, for the backlog event. */
  readonly backlogTasks: (clientId: string) => Effect.Effect<
    ReadonlyArray<{
      readonly taskId: string;
      readonly title: string;
      readonly status: string;
      readonly projectId: string;
    }>,
    EventStoreError
  >;
  readonly readiness: (
    clientId: string,
    at: number,
  ) => Effect.Effect<AgentBridgeClientReadiness | "none", EventStoreError>;
  /** Removes expired subscriptions, callbacks, and old diagnostics; returns orphaned secret refs. */
  readonly sweep: (at: number) => Effect.Effect<ReadonlyArray<string>, EventStoreError>;
}

export const makeEventStore = (sql: SqlClient.SqlClient): EventStore => {
  const fail =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new EventStoreError({ operation, cause })));
  const secretRefsOf = (
    rows: ReadonlyArray<{ secret_ref: string; previous_secret_ref: string | null }>,
  ) =>
    rows.flatMap((row) => [
      row.secret_ref,
      ...(row.previous_secret_ref ? [row.previous_secret_ref] : []),
    ]);

  return {
    get: (id) =>
      sql<SubscriptionRow>`SELECT * FROM agent_bridge_event_subscriptions WHERE id = ${id}`.pipe(
        Effect.map((rows) => (rows[0] ? toSubscription(rows[0]) : null)),
        fail("get"),
      ),
    listForClient: (clientId) =>
      sql<SubscriptionRow>`SELECT * FROM agent_bridge_event_subscriptions
        WHERE client_id = ${clientId} ORDER BY created_at`.pipe(
        Effect.map((rows) => rows.map(toSubscription)),
        fail("listForClient"),
      ),
    listDue: (at) =>
      sql<SubscriptionRow>`SELECT * FROM agent_bridge_event_subscriptions
        WHERE expires_at > ${iso(at)}
          AND (lease_until IS NULL OR lease_until <= ${iso(at)})
          AND (next_attempt_at IS NULL OR next_attempt_at <= ${iso(at)})
        ORDER BY client_id, created_at`.pipe(
        Effect.map((rows) => rows.map(toSubscription)),
        fail("listDue"),
      ),
    upsert: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<{
              secret_ref: string;
              expires_at: string;
            }>`SELECT secret_ref,
                expires_at FROM agent_bridge_event_subscriptions WHERE id = ${input.id}`;
            const current = existing[0];
            if (!current) {
              yield* sql`INSERT INTO agent_bridge_event_subscriptions (id, client_id,
                  token_family_id, grant_generation, name, arguments_json, url, secret_ref, status,
                  event_watermark, task_watermark, backlog_pending, expires_at, created_at,
                  updated_at)
                VALUES (${input.id}, ${input.clientId}, ${input.tokenFamilyId},
                  ${input.grantGeneration}, ${input.name}, ${JSON.stringify(input.arguments)},
                  ${input.url}, ${input.secretRef}, 'active', ${input.eventWatermark},
                  ${input.taskWatermark}, ${input.backlog ? 1 : 0}, ${input.expiresAt},
                  ${iso(input.at)}, ${iso(input.at)})`;
              return { created: true, replacedSecretRef: null };
            }
            // A renewal after a gap (the subscription had expired) emits a backlog event.
            const gap = Date.parse(current.expires_at) <= input.at;
            const secretChanged = current.secret_ref !== input.secretRef;
            yield* sql`UPDATE agent_bridge_event_subscriptions SET
                token_family_id = ${input.tokenFamilyId},
                grant_generation = ${input.grantGeneration},
                secret_ref = ${input.secretRef},
                previous_secret_ref = ${secretChanged ? current.secret_ref : null},
                previous_secret_until = ${secretChanged ? iso(input.at + VERIFIED_CALLBACK_TTL_MS) : null},
                expires_at = ${input.expiresAt},
                backlog_pending = CASE WHEN ${input.backlog || gap ? 1 : 0} = 1 THEN 1 ELSE backlog_pending END,
                event_watermark = CASE WHEN ${gap ? 1 : 0} = 1 THEN ${input.eventWatermark} ELSE event_watermark END,
                task_watermark = CASE WHEN ${gap ? 1 : 0} = 1 THEN ${input.taskWatermark} ELSE task_watermark END,
                updated_at = ${iso(input.at)}
              WHERE id = ${input.id}`;
            return { created: false, replacedSecretRef: secretChanged ? current.secret_ref : null };
          }),
        )
        .pipe(fail("upsert")),
    countForClient: (clientId) =>
      sql<{ n: number }>`SELECT COUNT(*) AS n FROM agent_bridge_event_subscriptions
        WHERE client_id = ${clientId}`.pipe(
        Effect.map((rows) => rows[0]?.n ?? 0),
        fail("countForClient"),
      ),
    remove: (id) =>
      sql<{ secret_ref: string; previous_secret_ref: string | null }>`DELETE FROM
        agent_bridge_event_subscriptions WHERE id = ${id}
        RETURNING secret_ref, previous_secret_ref`.pipe(Effect.map(secretRefsOf), fail("remove")),
    removeAll: Effect.gen(function* () {
      const rows = yield* sql<{ secret_ref: string; previous_secret_ref: string | null }>`DELETE
        FROM agent_bridge_event_subscriptions RETURNING secret_ref, previous_secret_ref`;
      yield* sql`DELETE FROM agent_bridge_verified_callbacks`;
      return secretRefsOf(rows);
    }).pipe(fail("removeAll")),
    removeForClient: (clientId) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ secret_ref: string; previous_secret_ref: string | null }>`DELETE
          FROM agent_bridge_event_subscriptions WHERE client_id = ${clientId}
          RETURNING secret_ref, previous_secret_ref`;
        yield* sql`DELETE FROM agent_bridge_verified_callbacks WHERE client_id = ${clientId}`;
        return secretRefsOf(rows);
      }).pipe(fail("removeForClient")),
    claim: (id, at) =>
      sql<{ id: string }>`UPDATE agent_bridge_event_subscriptions
        SET lease_until = ${iso(at + SUBSCRIPTION_LEASE_MS)}
        WHERE id = ${id} AND (lease_until IS NULL OR lease_until <= ${iso(at)})
        RETURNING id`.pipe(
        Effect.map((rows) => rows.length > 0),
        fail("claim"),
      ),
    release: (id) =>
      sql`UPDATE agent_bridge_event_subscriptions SET lease_until = NULL WHERE id = ${id}`.pipe(
        Effect.asVoid,
        fail("release"),
      ),
    setPendingEvent: (id, event) =>
      sql`UPDATE agent_bridge_event_subscriptions
        SET pending_event_json = ${JSON.stringify(event)}, attempt = 0
        WHERE id = ${id}`.pipe(Effect.asVoid, fail("setPendingEvent")),
    advance: (id, watermarks) =>
      sql`UPDATE agent_bridge_event_subscriptions
        SET event_watermark = MAX(event_watermark, ${watermarks.eventWatermark}),
          task_watermark = MAX(task_watermark, ${watermarks.taskWatermark})
        WHERE id = ${id}`.pipe(Effect.asVoid, fail("advance")),
    settle: (id, event, outcome) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ status: string }>`SELECT status
              FROM agent_bridge_event_subscriptions WHERE id = ${id}`;
            const wasFailed = rows[0]?.status === "delivery-failed";
            yield* sql`UPDATE agent_bridge_event_subscriptions SET
                event_watermark = MAX(event_watermark, ${event.eventWatermark}),
                task_watermark = MAX(task_watermark, ${event.taskWatermark}),
                backlog_pending = CASE
                  WHEN ${event.backlog ? 1 : 0} = 1 THEN 0
                  WHEN ${outcome.delivered && wasFailed ? 1 : 0} = 1 THEN 1
                  ELSE backlog_pending END,
                pending_event_json = NULL,
                attempt = 0,
                next_attempt_at = NULL,
                status = ${outcome.delivered ? "active" : "delivery-failed"},
                last_error = ${outcome.delivered ? null : "Delivery failed; the event was skipped."},
                last_delivered_at = CASE WHEN ${outcome.delivered ? 1 : 0} = 1
                  THEN ${iso(outcome.at)} ELSE last_delivered_at END,
                updated_at = ${iso(outcome.at)}
              WHERE id = ${id}`;
            yield* sql`INSERT INTO agent_bridge_event_deliveries (event_id, subscription_id, name,
                outcome, attempts, last_status, created_at)
              VALUES (${event.eventId}, ${id}, ${event.name},
                ${outcome.delivered ? "delivered" : "skipped"}, ${outcome.attempts},
                ${outcome.lastStatus}, ${iso(outcome.at)})`;
          }),
        )
        .pipe(fail("settle")),
    scheduleRetry: (id, input) =>
      sql`UPDATE agent_bridge_event_subscriptions SET attempt = ${input.attempt},
          next_attempt_at = ${iso(input.nextAttemptAt)}, last_error = ${input.error}
        WHERE id = ${id}`.pipe(Effect.asVoid, fail("scheduleRetry")),
    dropPending: (id, event) =>
      sql`UPDATE agent_bridge_event_subscriptions SET
          event_watermark = MAX(event_watermark, ${event.eventWatermark}),
          task_watermark = MAX(task_watermark, ${event.taskWatermark}),
          backlog_pending = CASE WHEN ${event.backlog ? 1 : 0} = 1 THEN 0 ELSE backlog_pending END,
          pending_event_json = NULL, attempt = 0, next_attempt_at = NULL
        WHERE id = ${id}`.pipe(Effect.asVoid, fail("dropPending")),
    nextDueAt: sql<{ next: string | null }>`SELECT MIN(next_attempt_at) AS next
      FROM agent_bridge_event_subscriptions WHERE next_attempt_at IS NOT NULL`.pipe(
      Effect.map((rows) => (rows[0]?.next ? Date.parse(rows[0].next) : null)),
      fail("nextDueAt"),
    ),
    recordGone: (id, event, at) =>
      event
        ? sql`INSERT INTO agent_bridge_event_deliveries (event_id, subscription_id, name, outcome,
              attempts, last_status, created_at)
            VALUES (${event.eventId}, ${id}, ${event.name}, 'gone', 1, 410, ${iso(at)})`.pipe(
            Effect.asVoid,
            fail("recordGone"),
          )
        : Effect.void,
    requestBacklog: (clientId) =>
      sql<{ id: string }>`UPDATE agent_bridge_event_subscriptions
        SET backlog_pending = 1, next_attempt_at = NULL, attempt = 0
        WHERE client_id = ${clientId} RETURNING id`.pipe(
        Effect.map((rows) => rows.length),
        fail("requestBacklog"),
      ),
    isCallbackVerified: (clientId, url, at) =>
      sql<{ n: number }>`SELECT COUNT(*) AS n FROM agent_bridge_verified_callbacks
        WHERE client_id = ${clientId} AND url = ${url} AND expires_at > ${iso(at)}`.pipe(
        Effect.map((rows) => (rows[0]?.n ?? 0) > 0),
        fail("isCallbackVerified"),
      ),
    markCallbackVerified: (clientId, url, at) =>
      sql`INSERT INTO agent_bridge_verified_callbacks (client_id, url, verified_at, expires_at)
        VALUES (${clientId}, ${url}, ${iso(at)}, ${iso(at + VERIFIED_CALLBACK_TTL_MS)})
        ON CONFLICT(client_id, url) DO UPDATE SET verified_at = excluded.verified_at,
          expires_at = excluded.expires_at`.pipe(Effect.asVoid, fail("markCallbackVerified")),
    isFamilyActive: (familyId, at) =>
      sql<{ n: number }>`SELECT COUNT(*) AS n FROM agent_bridge_tokens
        WHERE family_id = ${familyId} AND revoked_at IS NULL
          AND family_expires_at > ${iso(at)}`.pipe(
        Effect.map((rows) => (rows[0]?.n ?? 0) > 0),
        fail("isFamilyActive"),
      ),
    currentTaskRevision: sql<{ revision: number }>`SELECT revision FROM agent_bridge_revision
      WHERE id = 1`.pipe(
      Effect.map((rows) => rows[0]?.revision ?? 0),
      fail("currentTaskRevision"),
    ),
    taskActivitiesAfter: (clientId, revision, limit) =>
      sql<{
        task_id: string;
        revision: number;
        sequence: number;
        type: string;
        actor: "bot" | "operator";
        question_id: string | null;
        status: string;
        title: string;
        project_id: string;
      }>`SELECT a.task_id, a.revision, a.sequence, a.type, a.actor, a.question_id, t.status,
          t.title, t.project_id
        FROM bot_task_activities a JOIN bot_tasks t ON t.id = a.task_id
        WHERE t.client_id = ${clientId} AND a.revision > ${revision}
        ORDER BY a.revision, a.task_id, a.sequence LIMIT ${limit}`.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            taskId: row.task_id,
            revision: row.revision,
            sequence: row.sequence,
            type: row.type,
            actor: row.actor,
            questionId: row.question_id,
            status: row.status,
            title: row.title,
            projectId: row.project_id,
          })),
        ),
        fail("taskActivitiesAfter"),
      ),
    taskProject: (taskId, clientId) =>
      sql<{ project_id: string }>`SELECT project_id FROM bot_tasks
        WHERE id = ${taskId} AND client_id = ${clientId}`.pipe(
        Effect.map((rows) => rows[0]?.project_id ?? null),
        fail("taskProject"),
      ),
    backlogTasks: (clientId) =>
      sql<{ id: string; title: string; status: string; project_id: string }>`SELECT id, title,
          status, project_id FROM bot_tasks
        WHERE client_id = ${clientId} AND status IN ('queued', 'running')
        ORDER BY created_at LIMIT 50`.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            taskId: row.id,
            title: row.title,
            status: row.status,
            projectId: row.project_id,
          })),
        ),
        fail("backlogTasks"),
      ),
    readiness: (clientId, at) =>
      sql<{ status: string; expires_at: string }>`SELECT status, expires_at
        FROM agent_bridge_event_subscriptions WHERE client_id = ${clientId}`.pipe(
        Effect.map((rows) => {
          if (rows.length === 0) return "none" as const;
          const live = rows.filter((row) => Date.parse(row.expires_at) > at);
          if (live.length === 0) return "expired" as const;
          if (live.some((row) => row.status === "delivery-failed"))
            return "delivery-failed" as const;
          return "ready" as const;
        }),
        fail("readiness"),
      ),
    sweep: (at) =>
      Effect.gen(function* () {
        const now = iso(at);
        const expired = yield* sql<{
          secret_ref: string;
          previous_secret_ref: string | null;
        }>`DELETE
          FROM agent_bridge_event_subscriptions WHERE id IN (
            SELECT id FROM agent_bridge_event_subscriptions WHERE expires_at <= ${iso(at - 24 * 60 * 60 * 1000)}
            LIMIT 100)
          RETURNING secret_ref, previous_secret_ref`;
        // Previous secrets stop signing after their overlap window.
        // (RETURNING reports post-update values, so read the references first.)
        const rotated = yield* sql<{ id: string; previous_secret_ref: string | null }>`SELECT id,
            previous_secret_ref FROM agent_bridge_event_subscriptions
          WHERE previous_secret_until IS NOT NULL AND previous_secret_until <= ${now} LIMIT 100`;
        if (rotated.length > 0)
          yield* sql`UPDATE agent_bridge_event_subscriptions SET previous_secret_ref = NULL,
              previous_secret_until = NULL
            WHERE ${sql.in(
              "id",
              rotated.map((row) => row.id),
            )}`;
        yield* sql`DELETE FROM agent_bridge_verified_callbacks WHERE rowid IN (
          SELECT rowid FROM agent_bridge_verified_callbacks WHERE expires_at <= ${now} LIMIT 100)`;
        yield* sql`DELETE FROM agent_bridge_event_deliveries WHERE rowid IN (
          SELECT rowid FROM agent_bridge_event_deliveries
          WHERE created_at <= ${iso(at - DELIVERY_DIAGNOSTICS_TTL_MS)} LIMIT 100)`;
        return [
          ...secretRefsOf(expired),
          ...rotated.map((row) => row.previous_secret_ref).filter((ref) => ref !== null),
        ];
      }).pipe(fail("sweep")),
  };
};
