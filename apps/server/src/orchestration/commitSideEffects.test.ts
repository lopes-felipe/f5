import { afterEach, beforeEach, expect, it } from "vitest";
import { CommandId, OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import { Effect, ManagedRuntime, Option, Schema } from "effect";
import { makeCommitSideEffects } from "./commitSideEffects.ts";
import { createEmptyReadModel } from "./projector.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const at = "2026-10-19T00:00:00.000Z";
const threadId = ThreadId.make("commit-thread");
const commandId = CommandId.make("commit-command");
const readModel = createEmptyReadModel(at);
async function createSystem() {
  const runtime = ManagedRuntime.make(SqlitePersistenceMemory);
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  return {
    sql,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}
let system: Awaited<ReturnType<typeof createSystem>>;
beforeEach(async () => {
  system = await createSystem();
  await system.run(
    system.sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('project','Project','/fixture','[]',${at},${at})`,
  );
  await system.run(
    system.sql`INSERT INTO projection_threads(thread_id,project_id,title,model,created_at,last_interaction_at,updated_at) VALUES (${threadId},'project','Thread','gpt-5',${at},${at},${at})`,
  );
});
afterEach(async () => {
  await system?.dispose();
});

function event(type: OrchestrationEvent["type"], payload: Record<string, unknown>) {
  return Schema.decodeUnknownSync(OrchestrationEvent)({
    type,
    sequence: 3,
    eventId: "commit-event",
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: at,
    commandId,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: { threadId, ...payload },
  });
}
function apply(saved: OrchestrationEvent, steerFallback = false) {
  return system.run(
    system.sql.withTransaction(
      makeCommitSideEffects({
        sql: system.sql,
        transitions: Option.none(),
        queueStore: Option.none(),
      })(saved, { commandType: "thread.turn.start", steerFallback, readModel }),
    ),
  );
}
const attachment = {
  type: "image",
  id: "image",
  name: "image.png",
  mimeType: "image/png",
  sizeBytes: 1,
};
async function seedAttachment(owner = "ingress", lifecycle = "ready") {
  await system.run(
    system.sql`INSERT INTO attachments(attachment_id,thread_id,type,name,mime_type,size_bytes,content_hash,final_path,lifecycle,created_at,updated_at) VALUES ('image',${threadId},'image','image.png','image/png',1,'hash','image.png',${lifecycle},${at},${at})`,
  );
  if (lifecycle !== "deleting")
    await system.run(
      system.sql`INSERT INTO attachment_owners VALUES ('image',${owner},${commandId},${at})`,
    );
}
async function seedRewind(
  state: string,
  prior = { paused: 1, pause_reason_code: "manual_pause", pause_detail: "keep" },
) {
  await system.run(
    system.sql`INSERT INTO rewind_operations(operation_id,thread_id,target_message_id,provider_session_id,mode,expected_revision,state,relative_count,retained_count,boundary_json,draft_json,created_at,updated_at) VALUES ('operation',${threadId},'original','native','conversation',1,${state},1,0,'{}','{}',${at},${at})`,
  );
  await system.run(
    system.sql`INSERT INTO rewind_requests VALUES ('operation',${threadId},'{}',${at},${JSON.stringify(prior)})`,
  );
  await system.run(
    system.sql`INSERT INTO next_turn_queue_state(thread_id,paused,pause_reason_code,updated_at) VALUES (${threadId},1,'rewind_in_progress',${at})`,
  );
}

it.each(["thread.archived", "thread.deleted"] as const)(
  "cancels workspace transitions for %s",
  async (type) => {
    const cancelled: string[] = [];
    const commit = makeCommitSideEffects({
      sql: system.sql,
      transitions: Option.some({
        cancel: (id) =>
          Effect.sync(() => {
            cancelled.push(id);
          }),
      }),
      queueStore: Option.none(),
    });
    await system.run(
      system.sql.withTransaction(
        commit(event(type, type === "thread.archived" ? { archivedAt: at } : { deletedAt: at }), {
          commandType: "thread.turn.start",
          steerFallback: false,
          readModel,
        }),
      ),
    );
    expect(cancelled).toEqual([threadId]);
    if (type === "thread.archived")
      expect(
        await system.run(
          system.sql`SELECT paused, pause_reason_code FROM next_turn_queue_state WHERE thread_id=${threadId}`,
        ),
      ).toEqual([{ paused: 1, pause_reason_code: "thread_archived" }]);
  },
);

it.each(["thread.session-stop-requested", "thread.turn-interrupt-requested"] as const)(
  "commits %s cancellation without changing already sent deliveries",
  async (type) => {
    for (const state of ["pending", "sending", "accepted"])
      await system.run(
        system.sql`INSERT INTO provider_turn_deliveries(delivery_id,thread_id,command_id,message_id,state,event_json,created_at,updated_at) VALUES (${state},${threadId},${state},'message',${state},'{}',${at},${at})`,
      );
    await system.run(
      system.sql`INSERT INTO usage_limit_resumes(thread_id,limit_key,state,source,auto_eligible_at_failure,created_at,updated_at) VALUES (${threadId},'limit','scheduled','manual',0,${at},${at})`,
    );
    await apply(event(type, { createdAt: at }));
    expect(
      await system.run(
        system.sql`SELECT state,certainty FROM provider_turn_deliveries ORDER BY delivery_id`,
      ),
    ).toEqual([
      { state: "accepted", certainty: null },
      { state: "rejected", certainty: "not_sent" },
      { state: "sending", certainty: null },
    ]);
    expect((await system.run(system.sql`SELECT state FROM usage_limit_resumes`))[0]?.state).toBe(
      type === "thread.session-stop-requested" ? "cancelled" : "scheduled",
    );
  },
);

it("transfers attachment ownership with message commit and rolls back a failed transfer", async () => {
  await seedAttachment();
  const saved = event("thread.message-sent", {
    messageId: "message",
    role: "user",
    text: "prompt",
    streaming: false,
    createdAt: at,
    updatedAt: at,
    attachments: [attachment],
  });
  await apply(saved);
  expect(await system.run(system.sql`SELECT owner_kind,owner_id FROM attachment_owners`)).toEqual([
    { owner_kind: "message", owner_id: "message" },
  ]);
  await system.run(
    system.sql`CREATE TRIGGER refuse_owner BEFORE INSERT ON attachment_owners WHEN NEW.owner_kind='message' BEGIN SELECT RAISE(ABORT,'injected owner failure'); END`,
  );
  await system.run(system.sql`DELETE FROM attachment_owners`);
  await system.run(
    system.sql`INSERT INTO attachment_owners VALUES ('image','ingress',${commandId},${at})`,
  );
  await expect(apply(saved)).rejects.toThrow();
  expect(await system.run(system.sql`SELECT owner_kind FROM attachment_owners`)).toEqual([
    { owner_kind: "ingress" },
  ]);
});

it.each(["thread.turn-start-requested", "thread.turn-steer-requested"] as const)(
  "persists an idempotent delivery for %s and retries only a proven unsent fallback",
  async (type) => {
    const saved = event(type, {
      messageId: "message",
      createdAt: at,
      ...(type === "thread.turn-steer-requested" ? { expectedTurnId: "turn" } : {}),
    });
    await apply(saved);
    await apply(saved);
    expect(
      await system.run(system.sql`SELECT state,attempt FROM provider_turn_deliveries`),
    ).toEqual([{ state: "pending", attempt: 0 }]);
    await system.run(
      system.sql`UPDATE provider_turn_deliveries SET state='rejected',certainty='not_sent',attempt=2,error_code='steer_queued'`,
    );
    await apply(saved, true);
    expect(
      await system.run(
        system.sql`SELECT state,attempt,error_code,certainty FROM provider_turn_deliveries`,
      ),
    ).toEqual([{ state: "pending", attempt: 0, error_code: null, certainty: null }]);
    await system.run(
      system.sql`UPDATE provider_turn_deliveries SET state='ambiguous',certainty='unknown'`,
    );
    await apply(saved, true);
    expect(
      (await system.run(system.sql`SELECT state FROM provider_turn_deliveries`))[0]?.state,
    ).toBe("ambiguous");
  },
);

it("retains answered user-input attachments and refuses an answer queue that is unavailable", async () => {
  await seedAttachment();
  const saved = event("thread.user-input-resolved", {
    requestId: "request",
    resolution: "answered",
    createdAt: at,
    attachments: [attachment],
  });
  await apply(saved);
  expect(await system.run(system.sql`SELECT owner_kind,owner_id FROM attachment_owners`)).toEqual([
    { owner_kind: "user_input", owner_id: "request" },
  ]);
  const queued = event("thread.user-input-resolved", {
    ...saved.payload,
    command: {
      type: "thread.turn.start",
      commandId: "answer",
      threadId,
      message: { messageId: "answer-message", role: "user", text: "answer", attachments: [] },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: at,
    },
  });
  await expect(apply(queued)).rejects.toThrow("durable answer queue");
  expect(await system.run(system.sql`SELECT owner_kind FROM attachment_owners`)).toEqual([
    { owner_kind: "user_input" },
  ]);
});

it.each(["cancel", "resolve"] as const)(
  "settles a rewind draft with %s without losing ownership or the previous queue pause",
  async (intent) => {
    await seedRewind(intent === "cancel" ? "prepared" : "completed");
    await seedAttachment("rewind_draft");
    await system.run(system.sql`UPDATE attachment_owners SET owner_id='operation'`);
    await apply(event("thread.rewind-draft-resolved", { operationId: "operation", intent }));
    const owners = await system.run(system.sql`SELECT owner_kind,owner_id FROM attachment_owners`);
    if (intent === "cancel") {
      expect(owners).toEqual([{ owner_kind: "message", owner_id: "original" }]);
      expect(await system.run(system.sql`SELECT * FROM rewind_operations`)).toEqual([]);
      expect(
        (await system.run(system.sql`SELECT pause_reason_code FROM next_turn_queue_state`))[0]
          ?.pause_reason_code,
      ).toBe("manual_pause");
    } else {
      expect(owners).toEqual([]);
      expect(
        (await system.run(system.sql`SELECT draft_resolved_at FROM rewind_operations`))[0]
          ?.draft_resolved_at,
      ).toBe(at);
    }
  },
);

it("finishes a conversation revert while preserving the user's queue pause", async () => {
  await seedRewind("files-confirmed");
  await system.run(
    system.sql`INSERT INTO restart_turn_markers(thread_id, turn_id, marked_at, continuation_id) VALUES (${threadId},'turn',${at},'continuation')`,
  );
  await apply(event("thread.reverted", { operationId: "operation", turnCount: 0 }));
  expect((await system.run(system.sql`SELECT state FROM rewind_operations`))[0]?.state).toBe(
    "completed",
  );
  expect(
    (await system.run(system.sql`SELECT pause_reason_code FROM next_turn_queue_state`))[0]
      ?.pause_reason_code,
  ).toBe("manual_pause");
  expect(await system.run(system.sql`SELECT * FROM rewind_requests`)).toEqual([]);
  expect(await system.run(system.sql`SELECT * FROM restart_turn_markers`)).toEqual([]);
});

it("records a revert request and its prior queue state in one transaction", async () => {
  await system.run(
    system.sql`INSERT INTO next_turn_queue_state(thread_id,paused,pause_reason_code,updated_at) VALUES (${threadId},1,'manual_pause',${at})`,
  );
  const saved = event("thread.conversation-revert-requested", {
    type: "thread.conversation.revert",
    commandId,
    operationId: "operation",
    targetMessageId: "message",
    restoreFiles: false,
    createdAt: at,
  });
  await apply(saved);
  await apply(saved);
  const rows = await system.run(system.sql`SELECT queue_state_json FROM rewind_requests`);
  expect(rows).toHaveLength(1);
  expect(JSON.parse(String(rows[0]?.queue_state_json))).toMatchObject({
    paused: 1,
    pause_reason_code: "manual_pause",
  });
  expect(
    (await system.run(system.sql`SELECT pause_reason_code FROM next_turn_queue_state`))[0]
      ?.pause_reason_code,
  ).toBe("rewind_in_progress");
});
