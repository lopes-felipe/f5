import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ThreadId,
  type OrchestrationReadModel,
  type PlanningWorkflow,
} from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { project, thread } from "../agentBridge/testing/fakeHost.ts";
import { ProjectionThreadMessageRepositoryLive } from "../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "../persistence/Layers/ProjectionThreadProposedPlans.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepository } from "../persistence/Services/ProjectionThreadProposedPlans.ts";
import { THREAD_READ_RESULT_MAX_BYTES, type ThreadReadInput } from "./threadMcpTools.ts";
import { readReferencedThread } from "./threadToolRuntime.ts";

const layer = it.layer(
  Layer.mergeAll(
    ProjectionThreadMessageRepositoryLive,
    ProjectionThreadProposedPlanRepositoryLive,
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const CALLER = ThreadId.makeUnsafe("caller");
const SOURCE = ThreadId.makeUnsafe("source");

const baseModel = (): OrchestrationReadModel =>
  ({
    projects: [project("p"), project("other-project")],
    threads: [
      thread("caller", "p"),
      thread("source", "p", { title: "Source thread" }),
      thread("foreign", "other-project", { title: "Elsewhere" }),
      thread("deleted", "p", { deletedAt: "2026-01-01T00:00:00.000Z" }),
    ],
    planningWorkflows: [],
  }) as unknown as OrchestrationReadModel;

const at = (index: number) => new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();

const setup = (model: OrchestrationReadModel = baseModel()) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const messages = yield* ProjectionThreadMessageRepository;
    const plans = yield* ProjectionThreadProposedPlanRepository;
    // The layer's database is shared by every test here.
    yield* sql`DELETE FROM thread_reference_grants`;
    yield* sql`DELETE FROM projection_thread_messages`;
    yield* sql`DELETE FROM projection_thread_proposed_plans`;
    let current = model;
    const deps = {
      engine: { getReadModel: () => Effect.sync(() => current) },
      messages,
      plans,
      sql,
    };
    const read = (input: Partial<ThreadReadInput> & { threadId: string }, caller = CALLER) =>
      readReferencedThread(deps, caller, input as ThreadReadInput);
    const addMessage = (input: {
      readonly threadId: string;
      readonly id: string;
      readonly text: string;
      readonly createdAt: string;
      readonly role?: "user" | "assistant";
      readonly attachmentNames?: ReadonlyArray<string>;
    }) =>
      sql`INSERT OR IGNORE INTO projection_threads(thread_id,project_id,title,model,created_at,last_interaction_at,updated_at) VALUES(${input.threadId},'p','t','m',${at(0)},${at(0)},${at(0)})`.pipe(
        Effect.andThen(
          messages.upsert({
            messageId: MessageId.makeUnsafe(input.id),
            threadId: ThreadId.makeUnsafe(input.threadId),
            turnId: null,
            role: input.role ?? "assistant",
            text: input.text,
            reasoningText: "secret reasoning",
            attachments: (input.attachmentNames ?? ["shot.png"]).map((name, index) => ({
              type: "image" as const,
              id: `img-${index}`,
              name,
              mimeType: "image/png",
              sizeBytes: 3,
            })),
            isStreaming: false,
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
          }),
        ),
      );
    const grant = (input: { threadId: string; target: string; messageId: string }) =>
      Effect.gen(function* () {
        yield* addMessage({
          threadId: input.threadId,
          id: input.messageId,
          role: "user",
          text: `[Ref](f5://thread/${input.target})`,
          createdAt: at(0),
        });
        yield* sql`INSERT INTO thread_reference_grants(thread_id,target_thread_id,message_id,created_at)
          VALUES(${input.threadId},${input.target},${input.messageId},${at(0)})`;
      });
    return {
      sql,
      messages,
      plans,
      read,
      addMessage,
      grant,
      setModel: (next: OrchestrationReadModel) => (current = next),
    };
  });

layer("thread_read", (it) => {
  it.effect("refuses self, unreferenced, missing and malformed requests as values", () =>
    Effect.gen(function* () {
      const t = yield* setup();
      assert.deepInclude(yield* t.read({ threadId: "caller" }), { ok: false, reason: "self" });
      // A message carrying the link without a human grant (a Bot or scheduled send) is not enough.
      yield* t.addMessage({
        threadId: "caller",
        id: "bot-message",
        role: "user",
        text: "[Source](f5://thread/source)",
        createdAt: at(1),
      });
      assert.deepInclude(yield* t.read({ threadId: "source" }), {
        ok: false,
        reason: "not_referenced",
      });
      yield* t.grant({ threadId: "caller", target: "deleted", messageId: "g-deleted" });
      yield* t.grant({ threadId: "caller", target: "never-existed", messageId: "g-missing" });
      assert.deepInclude(yield* t.read({ threadId: "deleted" }), { reason: "not_found" });
      assert.deepInclude(yield* t.read({ threadId: "never-existed" }), { reason: "not_found" });
      yield* t.grant({ threadId: "caller", target: "source", messageId: "g-source" });
      assert.deepInclude(yield* t.read({ threadId: "source", before: "not-a-cursor" }), {
        reason: "invalid_cursor",
      });
      assert.deepInclude(
        yield* t.read({ threadId: "source", item: { kind: "message", id: "nope" } }),
        { reason: "invalid_item" },
      );
    }),
  );

  it.effect("stops authorizing once the granting message is gone", () =>
    Effect.gen(function* () {
      const t = yield* setup();
      yield* t.grant({ threadId: "caller", target: "source", messageId: "g-rewind" });
      assert.deepInclude(yield* t.read({ threadId: "source" }), { ok: true });
      yield* t.sql`DELETE FROM projection_thread_messages WHERE message_id = 'g-rewind'`;
      assert.deepInclude(yield* t.read({ threadId: "source" }), { reason: "not_referenced" });
    }),
  );

  it.effect("authorizes workflow stages for references in the human request", () =>
    Effect.gen(function* () {
      const model = baseModel();
      const t = yield* setup({
        ...model,
        planningWorkflows: [
          {
            deletedAt: null,
            requirementPrompt: "Plan from [Source](f5://thread/source)",
            branchA: { authorThreadId: "stage", reviews: [] },
            branchB: { authorThreadId: null, reviews: [] },
            merge: { threadId: null },
            readerPass: null,
            implementation: null,
          } as unknown as PlanningWorkflow,
        ],
      } as OrchestrationReadModel);
      const result = yield* t.read({ threadId: "source" }, ThreadId.makeUnsafe("stage"));
      assert.deepInclude(result, {
        ok: true,
        threadId: ThreadId.makeUnsafe("source"),
        title: "Source thread",
      });
    }),
  );

  it.effect("reads a granted thread in another project, and a plan-only source", () =>
    Effect.gen(function* () {
      const t = yield* setup();
      yield* t.grant({ threadId: "caller", target: "foreign", messageId: "g-foreign" });
      yield* t.plans.upsert({
        planId: "plan-1",
        threadId: ThreadId.makeUnsafe("foreign"),
        turnId: null,
        planMarkdown: "# Plan\n" + "é".repeat(5_000),
        implementedAt: null,
        implementationThreadId: null,
        createdAt: at(1),
        updatedAt: at(1),
      });
      const page = yield* t.read({ threadId: "foreign" });
      assert.isTrue(page.ok);
      if (!page.ok || !("messages" in page)) return assert.fail("expected a page");
      assert.deepStrictEqual(page.project, { id: "other-project", title: "other-project" });
      assert.deepStrictEqual(page.messages, []);
      assert.isNull(page.olderCursor);
      const plan = page.latestPlan!;
      assert.equal(plan.id, "plan-1");
      assert.isTrue("truncated" in plan && plan.truncated);
      assert.equal("totalLength" in plan ? plan.totalLength : 0, 5_007);
      // Continue the plan item to its end.
      let offset = "nextOffset" in plan ? plan.nextOffset : 0;
      let text = plan.text;
      for (let guard = 0; guard < 10; guard++) {
        const item = yield* t.read({
          threadId: "foreign",
          item: { kind: "plan", id: "plan-1", offset },
        });
        if (!item.ok || !("item" in item)) return assert.fail("expected an item");
        assert.isAbove(item.item.text.length, 0);
        text += item.item.text;
        if (item.item.nextOffset === null) break;
        assert.isAbove(item.item.nextOffset, offset);
        offset = item.item.nextOffset;
      }
      assert.equal(text, "# Plan\n" + "é".repeat(5_000));
    }),
  );

  it.effect("pages past the in-memory retention with a stable, advancing cursor", () =>
    Effect.gen(function* () {
      const t = yield* setup();
      yield* t.grant({ threadId: "caller", target: "source", messageId: "g-paging" });
      // Equal timestamps exercise the message id tiebreak.
      for (let index = 0; index < 2_100; index++)
        yield* t.addMessage({
          threadId: "source",
          id: `m-${String(index).padStart(5, "0")}`,
          text: `message ${index}`,
          createdAt: at(Math.floor(index / 3)),
        });
      const seen = new Set<string>();
      let before: string | undefined;
      let pages = 0;
      for (;;) {
        const page = yield* t.read({
          threadId: "source",
          limit: 50,
          ...(before ? { before } : {}),
        });
        if (!page.ok || !("messages" in page)) return assert.fail("expected a page");
        pages++;
        if (pages === 1) {
          // New messages arriving between pages do not shift the cursor.
          yield* t.addMessage({
            threadId: "source",
            id: "m-new",
            text: "late arrival",
            createdAt: at(10_000),
          });
        }
        const ids = page.messages.map((message) => String(message.id));
        assert.deepStrictEqual(ids, [...ids].sort());
        for (const id of ids) {
          assert.isFalse(seen.has(id));
          seen.add(id);
        }
        if (page.olderCursor === null) break;
        assert.notEqual(page.olderCursor, before);
        before = page.olderCursor;
      }
      assert.equal(seen.size, 2_100);
      assert.isFalse(seen.has("m-new"));
      assert.equal(pages, 42);
    }),
  );

  it.effect("keeps results under the byte cap, omits reasoning and continues long messages", () =>
    Effect.gen(function* () {
      const t = yield* setup();
      yield* t.grant({ threadId: "caller", target: "source", messageId: "g-size" });
      const long = `"\\\n${"漢".repeat(20_000)}`;
      for (let index = 0; index < 20; index++)
        yield* t.addMessage({
          threadId: "source",
          id: `big-${index}`,
          text: long,
          createdAt: at(index),
        });
      const page = yield* t.read({ threadId: "source" });
      if (!page.ok || !("messages" in page)) return assert.fail("expected a page");
      const wrapped = JSON.stringify({ content: [{ type: "text", text: JSON.stringify(page) }] });
      assert.isAtMost(Buffer.byteLength(wrapped), THREAD_READ_RESULT_MAX_BYTES);
      assert.isFalse(JSON.stringify(page).includes("secret reasoning"));
      assert.isAbove(page.messages.length, 0);
      assert.isNotNull(page.olderCursor);
      const newest = page.messages[page.messages.length - 1]!;
      assert.equal(newest.id, "big-19");
      assert.deepStrictEqual(newest.attachments, [{ name: "shot.png", type: "image" }]);
      let offset = Number(newest.nextOffset);
      let text = String(newest.text);
      for (let guard = 0; guard < 20; guard++) {
        const item = yield* t.read({
          threadId: "source",
          item: { kind: "message", id: "big-19", offset },
        });
        if (!item.ok || !("item" in item)) return assert.fail("expected an item");
        text += item.item.text;
        if (item.item.nextOffset === null) break;
        offset = item.item.nextOffset;
      }
      assert.equal(text, long);
      // Item reads are scoped to the referenced thread.
      yield* t.addMessage({ threadId: "foreign", id: "foreign-1", text: "x", createdAt: at(1) });
      assert.deepInclude(
        yield* t.read({ threadId: "source", item: { kind: "message", id: "foreign-1" } }),
        { reason: "invalid_item" },
      );
    }),
  );

  it.effect("keeps paging past a row with oversized attachment metadata", () =>
    Effect.gen(function* () {
      const t = yield* setup();
      yield* t.grant({ threadId: "caller", target: "source", messageId: "g-attach" });
      yield* t.addMessage({ threadId: "source", id: "older", text: "older", createdAt: at(1) });
      yield* t.addMessage({
        threadId: "source",
        id: "crowded",
        text: "x".repeat(10_000),
        createdAt: at(2),
        attachmentNames: Array.from({ length: 100 }, (_, index) => `${index}`.padEnd(250, "n")),
      });
      const page = yield* t.read({ threadId: "source", limit: 1 });
      if (!page.ok || !("messages" in page)) return assert.fail("expected a page");
      assert.deepStrictEqual(
        page.messages.map((message) => message.id),
        ["crowded"],
      );
      const [crowded] = page.messages;
      assert.equal(crowded?.attachmentCount, 100);
      assert.isAtMost((crowded?.attachments as unknown[] | undefined)?.length ?? 0, 10);
      assert.isAbove((crowded?.attachments as unknown[] | undefined)?.length ?? 0, 0);
      assert.isNotNull(page.olderCursor);
      const wrapped = JSON.stringify({ content: [{ type: "text", text: JSON.stringify(page) }] });
      assert.isAtMost(Buffer.byteLength(wrapped), THREAD_READ_RESULT_MAX_BYTES);
      const older = yield* t.read({ threadId: "source", before: page.olderCursor! });
      if (!older.ok || !("messages" in older)) return assert.fail("expected a page");
      assert.deepStrictEqual(
        older.messages.map((message) => message.id),
        ["older"],
      );
    }),
  );

  it.effect.each<readonly [string, string]>([
    ["backslashes", "\\".repeat(20_000)],
    ["replacement characters", "�".repeat(20_000)],
  ])("keeps %s item chunks within the result cap and always advances", ([, text]) =>
    Effect.gen(function* () {
      const t = yield* setup();
      yield* t.grant({ threadId: "caller", target: "source", messageId: "g-escape" });
      yield* t.addMessage({ threadId: "source", id: "slashes", text, createdAt: at(1) });
      let offset = 0;
      let read = "";
      for (let guard = 0; guard < 20; guard++) {
        const item = yield* t.read({
          threadId: "source",
          item: { kind: "message", id: "slashes", offset },
        });
        if (!item.ok || !("item" in item)) return assert.fail("expected an item");
        const wrapped = JSON.stringify({ content: [{ type: "text", text: JSON.stringify(item) }] });
        assert.isAtMost(Buffer.byteLength(wrapped), THREAD_READ_RESULT_MAX_BYTES);
        read += item.item.text;
        if (item.item.nextOffset === null) break;
        assert.isAbove(item.item.nextOffset, offset);
        offset = item.item.nextOffset;
      }
      assert.equal(read, text);
    }),
  );

  it.effect("bounds repository reads in SQL by code points", () =>
    Effect.gen(function* () {
      const t = yield* setup();
      yield* t.addMessage({
        threadId: "source",
        id: "emoji",
        text: "😀".repeat(5_000),
        createdAt: at(1),
      });
      const [row] = yield* t.messages.listContextPage({ threadId: SOURCE, limit: 1 });
      assert.equal(row?.totalLength, 5_000);
      assert.equal(Array.from(row?.text ?? "").length, 4_096);
      const item = yield* t.messages.getContextItem({
        threadId: SOURCE,
        messageId: MessageId.makeUnsafe("emoji"),
        offset: 4_999,
      });
      assert.equal(Option.getOrThrow(item).text, "😀");
    }),
  );
});
