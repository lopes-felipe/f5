import { createHmac, randomBytes } from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationEvent } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { makeAgentBridgeStore } from "../AgentBridgeStore.ts";
import { makeBotTaskStore } from "../BotTaskStore.ts";
import { makeOAuthStore } from "../OAuthStore.ts";
import type { OutboundRequest, OutboundResponse } from "../outboundHttps.ts";
import { FakeAgentBridgeHost, project, thread } from "../testing/fakeHost.ts";
import type { AgentBridgeCaller } from "../threadTools.ts";
import {
  CALLBACK_VERIFICATION_FAILED,
  deliveryBackoffMs,
  makeAgentBridgeEvents,
  type SecretVault,
} from "./AgentBridgeEvents.ts";
import { makeEventStore } from "./EventStore.ts";
import { decodeWebhookSecret, signWebhook } from "./webhook.ts";

const layer = it.layer(SqlitePersistenceMemory.pipe(Layer.provideMerge(NodeServices.layer)));

const secretString = (bytes = randomBytes(32)) => `whsec_${bytes.toString("base64")}`;

describe("webhook helpers", () => {
  it("accepts only whsec_ secrets of 24–64 bytes", () => {
    assert.isNotNull(decodeWebhookSecret(secretString(randomBytes(24))));
    assert.isNotNull(decodeWebhookSecret(secretString(randomBytes(64))));
    assert.isNull(decodeWebhookSecret(secretString(randomBytes(23))));
    assert.isNull(decodeWebhookSecret(secretString(randomBytes(65))));
    assert.isNull(decodeWebhookSecret(randomBytes(32).toString("base64")));
    assert.isNull(decodeWebhookSecret("whsec_not base64!"));
  });

  it("signs with Standard Webhooks v1 signatures, one per secret", () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    const expected = (key: Buffer) =>
      `v1,${createHmac("sha256", key).update("msg_1.1700000000.{}").digest("base64")}`;
    assert.strictEqual(
      signWebhook({ id: "msg_1", timestamp: 1_700_000_000, body: "{}", secrets: [a, b] }),
      `${expected(a)} ${expected(b)}`,
    );
  });

  it("backs off 1 s, 4 s, 16 s, 64 s and honors Retry-After up to 5 minutes", () => {
    assert.deepStrictEqual(
      [1, 2, 3, 4].map((attempt) => deliveryBackoffMs(attempt, null)),
      [1_000, 4_000, 16_000, 64_000],
    );
    assert.strictEqual(deliveryBackoffMs(1, 30), 30_000);
    assert.strictEqual(deliveryBackoffMs(1, 3_600), 300_000);
  });
});

interface Delivered {
  readonly request: OutboundRequest;
  readonly body: any;
}

const setup = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const clients = makeAgentBridgeStore(sql);
    const oauth = makeOAuthStore(sql);
    const tasks = makeBotTaskStore(sql);
    const store = makeEventStore(sql);
    const host = new FakeAgentBridgeHost();
    host.projects = [project("exposed"), project("hidden")];
    let clock = Date.parse("2026-10-15T12:00:00.000Z");
    const now = () => clock;
    const vault = new Map<string, Uint8Array>();
    const secrets: SecretVault = {
      get: (name) => Effect.sync(() => vault.get(name) ?? null),
      set: (name, value) => Effect.sync(() => void vault.set(name, value)),
      remove: (name) => Effect.sync(() => void vault.delete(name)),
    };
    const delivered: Delivered[] = [];
    const verifications: OutboundRequest[] = [];
    let respond: (body: any) => OutboundResponse = () => ({ status: 200, headers: {}, body: "" });
    let verificationEcho = true;
    const outbound = async (request: OutboundRequest): Promise<OutboundResponse> => {
      const body = JSON.parse(request.body ?? "{}");
      if (body.type === "verification") {
        verifications.push(request);
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ challenge: verificationEcho ? body.challenge : "wrong" }),
        };
      }
      delivered.push({ request, body });
      return respond(body);
    };
    const changed: string[] = [];
    const events = makeAgentBridgeEvents({
      store,
      clients,
      host: host.shape,
      secrets,
      outbound,
      visibleProjectIds: () => new Set(["exposed"]),
      onChanged: (ids) => changed.push(...ids),
      now,
    });

    // A remote client with a live token family.
    // (A metadata-document client: DCR's hourly limit would trip across tests sharing a database.)
    const clientId = `https://chatgpt.com/clients/${randomBytes(6).toString("hex")}`;
    yield* oauth.upsertCimdClient({
      clientId,
      name: "Dot",
      redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      at: clock,
    });
    const generation = yield* oauth.setGrant({
      clientId,
      scopes: ["f5.read", "f5.tasks", "f5.events"],
      projectIds: ["exposed"],
    });
    const issued = yield* oauth.issueTokens({
      clientId,
      scopes: ["f5.read", "f5.tasks", "f5.events"],
      resource: "https://f5.example.com/mcp",
      grantGeneration: generation,
      at: clock,
    });
    const familyId = (yield* oauth.findAccessToken(issued.accessToken, clock))!.familyId;
    const caller = Effect.gen(function* () {
      const client = (yield* clients.getClient(clientId))!;
      return {
        client,
        visibleProjectIds: new Set(["exposed"]),
        tokenFamilyId: familyId,
      } satisfies AgentBridgeCaller;
    });
    const call = (method: string, params: Record<string, unknown>) =>
      Effect.gen(function* () {
        const handled = events.handleMethod(method, params, yield* caller);
        return (yield* handled!) as { result?: any; error?: { code: number; data?: any } };
      });
    const subscribe = (name: string, overrides: Record<string, unknown> = {}) =>
      call("events/subscribe", {
        name,
        arguments: {},
        delivery: { mode: "webhook", url: "https://hooks.example/f5", secret: secretString() },
        ...overrides,
      });
    let op = 0;
    const createTask = (title = "Summarize") =>
      tasks.create(
        {
          namespace: "operator",
          operationId: `${clientId}-op-${++op}`,
          tool: "createTask",
          args: { title, op },
        },
        {
          clientId,
          projectId: "exposed",
          sourceThreadId: null,
          title,
          instructions: "Do it.",
          taskId: `${clientId}-task-${op}`,
          at: new Date(clock).toISOString(),
        },
      );
    return {
      sql,
      clients,
      oauth,
      tasks,
      store,
      host,
      events,
      vault,
      delivered,
      verifications,
      changed,
      clientId,
      familyId,
      call,
      subscribe,
      createTask,
      setRespond: (next: (body: any) => OutboundResponse) => {
        respond = next;
      },
      setVerificationEcho: (value: boolean) => {
        verificationEcho = value;
      },
      advance: (ms: number) => {
        clock += ms;
      },
      now,
    };
  });

const sessionSettled = (sequence: number, threadId: string, turnId: string): OrchestrationEvent =>
  ({
    sequence,
    eventId: `event-${sequence}`,
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.session-set",
    occurredAt: "2026-10-15T12:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId,
      settledTurnId: turnId,
      session: { status: "ready", lastError: null },
    },
  }) as unknown as OrchestrationEvent;

layer("Agent Bridge MCP Events", (it) => {
  it.effect("lists the event catalog", () =>
    Effect.gen(function* () {
      const { call } = yield* setup();
      const listed = yield* call("events/list", {});
      assert.deepStrictEqual(
        listed.result.events.map((event: { name: string }) => event.name),
        [
          "thread.turn_completed",
          "thread.approval_requested",
          "thread.input_requested",
          "tasks.available",
          "task.updated",
        ],
      );
    }),
  );

  it.effect("verifies the callback before activating, and caches the verification", () =>
    Effect.gen(function* () {
      const { subscribe, setVerificationEcho, verifications } = yield* setup();
      setVerificationEcho(false);
      const failed = yield* subscribe("tasks.available");
      assert.strictEqual(failed.error?.code, CALLBACK_VERIFICATION_FAILED);
      assert.strictEqual(failed.error?.data.reason, "challenge-mismatch");
      setVerificationEcho(true);
      const ok = yield* subscribe("tasks.available");
      assert.isString(ok.result.id);
      assert.isFalse(ok.result.truncated);
      const second = yield* subscribe("task.updated");
      assert.isString(second.result.id);
      assert.strictEqual(verifications.length, 2);
      // Verification requests are signed.
      assert.match(String(verifications[1]!.headers?.["webhook-signature"]), /^v1,/u);
    }),
  );

  it.effect("rejects bad subscriptions", () =>
    Effect.gen(function* () {
      const { subscribe } = yield* setup();
      assert.strictEqual((yield* subscribe("nope")).error?.code, -32602);
      assert.strictEqual(
        (yield* subscribe("tasks.available", {
          delivery: { mode: "webhook", url: "https://hooks.example/x", secret: "plain" },
        })).error?.code,
        -32602,
      );
      assert.strictEqual(
        (yield* subscribe("tasks.available", {
          delivery: { mode: "webhook", url: "http://hooks.example/x", secret: secretString() },
        })).error?.code,
        -32602,
      );
      assert.strictEqual(
        (yield* subscribe("thread.turn_completed", { arguments: { threadIds: ["missing"] } })).error
          ?.code,
        -32602,
      );
    }),
  );

  it.effect("limits a client to 8 subscriptions", () =>
    Effect.gen(function* () {
      const { subscribe } = yield* setup();
      for (let index = 0; index < 8; index++) {
        const result = yield* subscribe("tasks.available", {
          delivery: {
            mode: "webhook",
            url: `https://hooks.example/${index}`,
            secret: secretString(),
          },
        });
        assert.isString(result.result?.id);
      }
      const ninth = yield* subscribe("tasks.available", {
        delivery: { mode: "webhook", url: "https://hooks.example/9", secret: secretString() },
      });
      assert.strictEqual(ninth.error?.code, -32602);
    }),
  );

  it.effect("a queued task discovered after subscribing: backlog, then tasks.available", () =>
    Effect.gen(function* () {
      const { subscribe, createTask, events, delivered, store, clientId } = yield* setup();
      yield* createTask("Before subscribing");
      const subscription = yield* subscribe("tasks.available");
      yield* events.drain;
      assert.strictEqual(delivered.length, 1);
      assert.strictEqual(delivered[0]!.body.name, "tasks.available");
      assert.isTrue(delivered[0]!.body.payload.backlog);
      assert.deepStrictEqual(
        delivered[0]!.body.payload.tasks.map((task: { title: string }) => task.title),
        ["Before subscribing"],
      );
      const headers = delivered[0]!.request.headers!;
      assert.strictEqual(headers["webhook-id"], delivered[0]!.body.id);
      assert.strictEqual(headers["x-mcp-subscription-id"], subscription.result.id);

      yield* createTask("After subscribing");
      yield* events.drain;
      assert.strictEqual(delivered.length, 2);
      assert.isUndefined(delivered[1]!.body.payload.backlog);
      assert.deepStrictEqual(
        delivered[1]!.body.payload.tasks.map((task: { title: string }) => task.title),
        ["After subscribing"],
      );
      // Nothing new: nothing delivered.
      yield* events.drain;
      assert.strictEqual(delivered.length, 2);
      assert.strictEqual(yield* store.readiness(clientId, Date.now()), "ready");
    }),
  );

  it.effect("task.updated reports operator changes", () =>
    Effect.gen(function* () {
      const { subscribe, createTask, events, delivered, tasks, clientId } = yield* setup();
      const created = yield* createTask();
      yield* subscribe("task.updated");
      yield* events.drain;
      const backlogCount = delivered.length;
      yield* tasks.control(
        { namespace: "operator", operationId: `${clientId}-pause`, tool: "pauseTask", args: {} },
        { taskId: created.taskId, action: "pause", at: new Date().toISOString() },
      );
      yield* events.drain;
      const update = delivered.at(-1)!;
      assert.strictEqual(delivered.length, backlogCount + 1);
      assert.deepStrictEqual(update.body.payload, { taskId: created.taskId, status: "paused" });
    }),
  );

  it.effect("thread.turn_completed for threads the client created, skipping others", () =>
    Effect.gen(function* () {
      const { subscribe, events, delivered, host, sql, clientId } = yield* setup();
      host.threads = [
        thread(`${clientId}-mine`, "exposed", {
          messages: [
            {
              id: "m1",
              role: "assistant",
              text: "All done.",
              turnId: "turn-1",
            },
          ] as never,
        }),
        thread(`${clientId}-other`, "exposed"),
      ];
      yield* sql`INSERT INTO agent_bridge_threads (thread_id, client_id, request_id, created_at)
        VALUES (${`${clientId}-mine`}, ${clientId}, 'r1', '2026-10-15T12:00:00.000Z')`;
      yield* subscribe("thread.turn_completed");
      host.events = [
        sessionSettled(1, `${clientId}-other`, "turn-0"),
        sessionSettled(2, `${clientId}-mine`, "turn-1"),
      ];
      yield* events.drain;
      assert.strictEqual(delivered.length, 1);
      assert.deepStrictEqual(delivered[0]!.body.payload, {
        threadId: `${clientId}-mine`,
        turnId: "turn-1",
        status: "completed",
        summary: "All done.",
      });
    }),
  );

  it.effect("retries with the same event id, then skips and marks delivery-failed", () =>
    Effect.gen(function* () {
      const { subscribe, createTask, events, delivered, setRespond, advance, store, clientId } =
        yield* setup();
      const subscription = yield* subscribe("tasks.available");
      yield* events.drain; // backlog
      setRespond(() => ({ status: 503, headers: {}, body: "" }));
      yield* createTask();
      const before = delivered.length;
      yield* events.drain;
      assert.strictEqual(delivered.length, before + 1);
      const eventId = delivered.at(-1)!.body.id;
      // Not due yet.
      yield* events.drain;
      assert.strictEqual(delivered.length, before + 1);
      for (const wait of [1_000, 4_000, 16_000, 64_000]) {
        advance(wait);
        yield* events.drain;
      }
      assert.strictEqual(delivered.length, before + 5);
      assert.isTrue(delivered.slice(before).every((entry) => entry.body.id === eventId));
      const timestamps = delivered
        .slice(before)
        .map((entry) => entry.request.headers!["webhook-timestamp"]);
      assert.strictEqual(new Set(timestamps).size, 5);
      const record = yield* store.get(subscription.result.id);
      assert.strictEqual(record?.status, "delivery-failed");
      assert.isNull(record?.pendingEvent);
      assert.strictEqual(yield* store.readiness(clientId, Date.now()), "delivery-failed");

      // The next successful delivery recovers and emits a backlog event.
      setRespond(() => ({ status: 200, headers: {}, body: "" }));
      yield* createTask("Recovered");
      yield* events.drain;
      const recovered = yield* store.get(subscription.result.id);
      assert.strictEqual(recovered?.status, "active");
      assert.isTrue(delivered.at(-1)!.body.payload.backlog);
    }),
  );

  it.effect("410 deletes the subscription and its secret", () =>
    Effect.gen(function* () {
      const { subscribe, createTask, events, setRespond, store, vault } = yield* setup();
      setRespond(() => ({ status: 410, headers: {}, body: "" }));
      yield* createTask();
      const subscription = yield* subscribe("tasks.available");
      const ref = (yield* store.get(subscription.result.id))!.secretRef;
      assert.isTrue(vault.has(ref));
      yield* events.drain;
      assert.isNull(yield* store.get(subscription.result.id));
      assert.isFalse(vault.has(ref));
    }),
  );

  it.effect("a restarted worker resumes from the stored watermarks", () =>
    Effect.gen(function* () {
      const setupResult = yield* setup();
      const { subscribe, createTask, events, delivered, clientId } = setupResult;
      yield* subscribe("tasks.available");
      yield* events.drain;
      yield* createTask("One");
      yield* events.drain;
      const count = delivered.length;
      // A second instance over the same storage delivers nothing twice.
      const restarted = makeAgentBridgeEvents({
        store: setupResult.store,
        clients: setupResult.clients,
        host: setupResult.host.shape,
        secrets: {
          get: (name) => Effect.sync(() => setupResult.vault.get(name) ?? null),
          set: (name, value) => Effect.sync(() => void setupResult.vault.set(name, value)),
          remove: (name) => Effect.sync(() => void setupResult.vault.delete(name)),
        },
        outbound: async (request) => {
          delivered.push({ request, body: JSON.parse(request.body ?? "{}") });
          return { status: 200, headers: {}, body: "" };
        },
        visibleProjectIds: () => new Set(["exposed"]),
        onChanged: () => undefined,
        now: setupResult.now,
      });
      yield* restarted.drain;
      assert.strictEqual(delivered.length, count);
      yield* createTask("Two");
      yield* restarted.drain;
      assert.strictEqual(delivered.length, count + 1);
      assert.strictEqual(delivered.at(-1)!.body.payload.tasks[0].title, "Two");
      assert.isString(clientId);
    }),
  );

  it.effect("revoked tokens, grant changes, and revocation stop delivery", () =>
    Effect.gen(function* () {
      const { subscribe, createTask, events, delivered, oauth, clientId, store, vault } =
        yield* setup();
      const subscription = yield* subscribe("tasks.available");
      yield* events.drain;
      const count = delivered.length;
      yield* oauth.setGrant({
        clientId,
        scopes: ["f5.read", "f5.tasks", "f5.events"],
        projectIds: ["exposed"],
      });
      yield* createTask();
      yield* events.drain;
      assert.strictEqual(delivered.length, count);
      const ref = (yield* store.get(subscription.result.id))!.secretRef;
      yield* events.removeClient(clientId);
      assert.isNull(yield* store.get(subscription.result.id));
      assert.isFalse(vault.has(ref));
    }),
  );

  it.effect("readiness: linked, awaiting subscription, ready", () =>
    Effect.gen(function* () {
      const { events, clients, oauth, clientId, subscribe } = yield* setup();
      yield* oauth.setGrant({ clientId, scopes: ["f5.read"], projectIds: [] });
      assert.strictEqual(yield* events.readiness((yield* clients.getClient(clientId))!), "linked");
      yield* oauth.setGrant({ clientId, scopes: ["f5.read", "f5.events"], projectIds: [] });
      const client = (yield* clients.getClient(clientId))!;
      assert.strictEqual(yield* events.readiness(client), "awaiting-subscription");
      // The subscription below binds the current generation.
      yield* subscribe("tasks.available");
      assert.strictEqual(yield* events.readiness(client), "ready");
      assert.isNull(
        yield* events.readiness((yield* clients.getClient("local")) ?? { ...client, id: "local" }),
      );
    }),
  );

  it.effect("re-subscribing with a new secret signs with both for 24 hours", () =>
    Effect.gen(function* () {
      const { subscribe, createTask, events, delivered } = yield* setup();
      yield* subscribe("tasks.available");
      yield* events.drain;
      yield* subscribe("tasks.available");
      yield* createTask();
      yield* events.drain;
      const signature = String(delivered.at(-1)!.request.headers!["webhook-signature"]);
      assert.strictEqual(signature.split(" ").length, 2);
    }),
  );
});
