import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AGENT_BRIDGE_LOCAL_CLIENT_ID,
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ProviderDriverKind,
  ProjectId,
  ThreadId,
  TurnId,
  type NextTurnQueueSnapshot,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { Deferred, Effect, Exit, Fiber, Layer, PubSub } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestClock } from "effect/testing";

import type { NextTurnQueueSubmissionRecord } from "../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeAgentBridgeStore, type AgentBridgeClientRecord } from "./AgentBridgeStore.ts";
import { AGENT_BRIDGE_LIMITS, makeAgentBridgeLimiters } from "./rateLimits.ts";
import { emptyQueue, FakeAgentBridgeHost, project, provider, thread } from "./testing/fakeHost.ts";
import {
  makeThreadTools,
  truncateUtf8,
  type AgentBridgeCaller,
  type AgentBridgeToolDefinition,
} from "./threadTools.ts";

const layer = it.layer(SqlitePersistenceMemory.pipe(Layer.provideMerge(NodeServices.layer)));

const startedRecord = (
  submissionId: string,
  threadId: string,
  messageId: string,
): NextTurnQueueSubmissionRecord => ({
  submissionId: CommandId.makeUnsafe(submissionId),
  threadId: ThreadId.makeUnsafe(threadId),
  requestHash: "",
  itemId: null,
  messageId: messageId as never,
  disposition: "started",
  resultSequence: null,
  reasonCode: null,
  createdAt: "",
  settledAt: "",
});

const latestTurn = (turnId: string, state: "running" | "completed") => ({
  turnId: TurnId.makeUnsafe(turnId),
  state,
  requestedAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  completedAt: null,
  assistantMessageId: null,
});

const setup = (options: { now?: () => number } = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = makeAgentBridgeStore(sql);
    yield* store.ensureLocalClient;
    const client = (yield* store.getClient(
      AGENT_BRIDGE_LOCAL_CLIENT_ID,
    )) as AgentBridgeClientRecord;
    const host = new FakeAgentBridgeHost();
    host.settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("claude")]: { driver: ProviderDriverKind.make("claudeAgent") },
      },
    };
    host.projects = [project("exposed"), project("hidden")];
    // The database is shared across tests, so ids must be unique per setup.
    const prefix = crypto.randomUUID().slice(0, 8);
    let counter = 0;
    const tools = makeThreadTools({
      host: host.shape,
      store,
      limiters: makeAgentBridgeLimiters(options.now),
      mintId: () => `${prefix}-${++counter}`,
    });
    const caller: AgentBridgeCaller = { client, visibleProjectIds: new Set(["exposed"]) };
    const tool = (name: string) =>
      tools.find((entry) => entry.name === name) as AgentBridgeToolDefinition;
    const run = (name: string, args: Record<string, unknown>, as: AgentBridgeCaller = caller) =>
      tool(name)
        .run(args, as)
        .pipe(
          Effect.map((value) => ({ ok: true as const, value: value as any })),
          Effect.catchTag("AgentBridgeToolError", (error) =>
            Effect.succeed({ ok: false as const, error }),
          ),
        );
    return { store, host, tools, caller, run, client };
  });

layer("Agent Bridge thread tools", (it) => {
  it.effect("exposes no tool that controls approvals, work, settings, or files", () =>
    Effect.gen(function* () {
      const { tools } = yield* setup();
      assert.deepStrictEqual(
        tools.map((tool) => tool.name),
        [
          "list_projects",
          "list_providers",
          "list_threads",
          "get_thread",
          "get_thread_diff",
          "create_thread",
          "send_message",
          "wait_for_submission",
        ],
      );
      for (const tool of tools) {
        assert.include(tool.description, "coding-workspace service");
        assert.include(tool.description, "does not control your computer");
      }
    }),
  );

  it.effect("hides unexposed projects and their threads", () =>
    Effect.gen(function* () {
      const { host, run } = yield* setup();
      host.threads = [thread("t-hidden", "hidden"), thread("t-exposed", "exposed")];
      const projects = yield* run("list_projects", {});
      assert.deepStrictEqual(
        projects.ok && projects.value.projects.map((entry: { id: string }) => entry.id),
        ["exposed"],
      );
      const threads = yield* run("list_threads", {});
      assert.deepStrictEqual(
        threads.ok && threads.value.threads.map((entry: { id: string }) => entry.id),
        ["t-exposed"],
      );
      for (const name of ["get_thread", "get_thread_diff", "send_message"]) {
        const result = yield* run(name, { threadId: "t-hidden", prompt: "x" });
        assert.isFalse(result.ok);
        assert.strictEqual(!result.ok && result.error.message, "Thread not found.");
      }
      const created = yield* run("create_thread", { projectId: "hidden", prompt: "x" });
      assert.strictEqual(!created.ok && created.error.message, "Project not found.");
    }),
  );

  it.effect("creates supervised threads and refuses providers without supervised mode", () =>
    Effect.gen(function* () {
      const { host, run } = yield* setup();
      host.providers = [provider("muse", "muse", ["muse-spark-1.3"]), provider("codex", "codex")];
      host.settings = {
        ...host.settings,
        providers: {
          ...host.settings.providers,
          muse: { ...host.settings.providers.muse, enabled: true },
        },
      };
      const muse = yield* run("create_thread", {
        projectId: "exposed",
        prompt: "Hi",
        providerInstanceId: "muse",
      });
      assert.isFalse(muse.ok);
      assert.include(!muse.ok ? muse.error.message : "", "cannot run supervised turns");

      const providers = yield* run("list_providers", {});
      assert.deepStrictEqual(
        providers.ok &&
          providers.value.providers.map(
            (entry: { instanceId: string; supportsSupervised: boolean }) => [
              entry.instanceId,
              entry.supportsSupervised,
            ],
          ),
        [
          ["muse", false],
          ["codex", true],
        ],
      );

      // The default text-generation instance is Codex; Muse is skipped either way.
      const created = yield* run("create_thread", { projectId: "exposed", prompt: "Hi" });
      assert.isTrue(created.ok);
      const command = host.submissions[0]!.command;
      assert.strictEqual(command.runtimeMode, "approval-required");
      assert.strictEqual(command.bootstrap?.createThread?.runtimeMode, "approval-required");
      assert.strictEqual(command.modelSelection?.instanceId, "codex");
      assert.isDefined(command.bootstrap?.prepareWorktree);
      assert.strictEqual(host.dispatched.length, 1);
      assert.strictEqual(
        host.dispatched[0]!.activity.summary,
        "Sent by Local MCP client via F5 Agent Bridge",
      );
    }),
  );

  it.effect("skips providers that are not installed or not signed in", () =>
    Effect.gen(function* () {
      const { host, run } = yield* setup();
      host.providers = [
        {
          ...provider("claude", "claudeAgent"),
          status: "error",
          auth: { status: "unauthenticated" },
        },
        { ...provider("grok", "grok"), installed: false, status: "error" },
        provider("codex", "codex"),
      ];
      host.settings = {
        ...host.settings,
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("claude"),
          model: "model-a",
        },
      };
      const providers = yield* run("list_providers", {});
      assert.deepStrictEqual(
        providers.ok &&
          providers.value.providers.map((entry: { instanceId: string; available: boolean }) => [
            entry.instanceId,
            entry.available,
          ]),
        [
          ["claude", false],
          ["grok", false],
          ["codex", true],
        ],
      );
      const refused = yield* run("create_thread", {
        projectId: "exposed",
        prompt: "Hi",
        providerInstanceId: "claude",
      });
      assert.isFalse(refused.ok);
      assert.include(!refused.ok ? refused.error.message : "", "not ready");
      // The default falls past the signed-out text-generation default.
      const created = yield* run("create_thread", { projectId: "exposed", prompt: "Hi" });
      assert.isTrue(created.ok);
      assert.strictEqual(host.submissions[0]!.command.modelSelection?.instanceId, "codex");
    }),
  );

  it.effect("defaults to the provider's coding model, not the text-generation model", () =>
    Effect.gen(function* () {
      const { host, run } = yield* setup();
      const codingDefault = DEFAULT_MODEL_BY_PROVIDER.codex;
      host.providers = [provider("codex", "codex", ["small-model", codingDefault])];
      host.settings = {
        ...host.settings,
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "small-model",
        },
      };
      const created = yield* run("create_thread", { projectId: "exposed", prompt: "Hi" });
      assert.isTrue(created.ok);
      assert.strictEqual(host.submissions[0]!.command.model, codingDefault);
    }),
  );

  it.effect("skips an unlisted Claude coding default", () =>
    Effect.gen(function* () {
      const { host, run } = yield* setup();
      const claude = provider("claude", "claudeAgent", ["claude-opus-5-5", "claude-opus-4-6"]);
      host.providers = [
        {
          ...claude,
          models: claude.models.map((model) => ({
            ...model,
            isUnlisted: model.slug === "claude-opus-5-5",
          })),
        },
      ];
      const created = yield* run("create_thread", { projectId: "exposed", prompt: "Hi" });
      assert.isTrue(created.ok);
      assert.strictEqual(host.submissions[0]!.command.model, "claude-opus-4-6");
    }),
  );

  it.effect("does not advertise or accept unlisted models for new bridge threads", () =>
    Effect.gen(function* () {
      const { host, run } = yield* setup();
      const claude = provider("claude", "claudeAgent", ["claude-haiku-5-5", "claude-haiku-4-5"]);
      host.providers = [
        {
          ...claude,
          models: claude.models.map((model) => ({
            ...model,
            isUnlisted: model.slug === "claude-haiku-5-5",
          })),
        },
      ];
      const listed = yield* run("list_providers", {});
      assert.isTrue(listed.ok);
      if (listed.ok)
        assert.deepStrictEqual(
          listed.value.providers[0].models.map((model: { slug: string }) => model.slug),
          ["claude-haiku-4-5"],
        );
      const created = yield* run("create_thread", {
        projectId: "exposed",
        prompt: "Hi",
        providerInstanceId: "claude",
        model: "claude-haiku-5-5",
      });
      assert.isFalse(created.ok);
      assert.strictEqual(host.submissions.length, 0);
    }),
  );

  it.effect("scopes provider lists and new-thread admission to an exposed project", () =>
    Effect.gen(function* () {
      const { host, run } = yield* setup();
      const codex = ProviderInstanceId.make("codex"),
        claude = ProviderInstanceId.make("claude");
      host.providers = [provider(codex, "codex"), provider(claude, "claudeAgent")];
      host.settings = {
        ...host.settings,
        projectSettingsOverrides: {
          [ProjectId.makeUnsafe("exposed")]: { providerInstances: { [codex]: { enabled: false } } },
        },
      };
      const global = yield* run("list_providers", {});
      const scoped = yield* run("list_providers", { projectId: "exposed" });
      assert.deepStrictEqual(
        global.ok && global.value.providers.map((p: { instanceId: string }) => p.instanceId),
        [codex, claude],
      );
      assert.deepStrictEqual(
        scoped.ok && scoped.value.providers.map((p: { instanceId: string }) => p.instanceId),
        [claude],
      );
      assert.isFalse((yield* run("list_providers", { projectId: "hidden" })).ok);
      assert.isFalse(
        (yield* run("create_thread", {
          projectId: "exposed",
          prompt: "x",
          providerInstanceId: codex,
        })).ok,
      );
      assert.isTrue((yield* run("create_thread", { projectId: "exposed", prompt: "x" })).ok);
      assert.strictEqual(host.submissions[0]?.command.modelSelection?.instanceId, claude);
    }),
  );

  it.effect("uses the checkout for non-git projects", () =>
    Effect.gen(function* () {
      const { host, run } = yield* setup();
      host.branches.set("/repo/exposed", null);
      const created = yield* run("create_thread", { projectId: "exposed", prompt: "Hi" });
      assert.isTrue(created.ok);
      assert.isUndefined(host.submissions[0]!.command.bootstrap?.prepareWorktree);
    }),
  );

  it.effect("replays retries, rejects changed arguments, and keeps the first command", () =>
    Effect.gen(function* () {
      const { host, run } = yield* setup();
      host.providers = [provider("codex", "codex"), provider("claude", "claudeAgent")];
      const args = { projectId: "exposed", prompt: "Hi", clientRequestId: "req-1" };

      // A transient failure before admission leaves a pending receipt.
      host.failNextBeforeAdmission = { message: "busy" };
      const failed = yield* run("create_thread", args);
      assert.isFalse(failed.ok);

      // The default provider changes; the retry still sends the stored command.
      host.settings = {
        ...host.settings,
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("claude"),
          model: "model-a",
        },
      };
      const [first, concurrent] = yield* Effect.all(
        [run("create_thread", args), run("create_thread", args)],
        {
          concurrency: "unbounded",
        },
      );
      assert.isTrue(first.ok);
      assert.deepStrictEqual(concurrent, first);
      assert.strictEqual(host.submissions.length, 1);
      assert.strictEqual(host.submissions[0]!.command.modelSelection?.instanceId, "codex");

      const again = yield* run("create_thread", args);
      assert.deepStrictEqual(again, first);
      const changed = yield* run("create_thread", { ...args, prompt: "Different" });
      assert.isFalse(changed.ok);
      assert.include(
        !changed.ok ? changed.error.message : "",
        "already used with different arguments",
      );
    }),
  );

  it.effect("returns the original result with one activity after a crash before the reply", () =>
    Effect.gen(function* () {
      const { host, run } = yield* setup();
      host.failNextAfterAdmission = true;
      const args = { projectId: "exposed", prompt: "Hi", clientRequestId: "req-crash" };
      const lost = yield* run("create_thread", args);
      assert.isFalse(lost.ok);
      const retried = yield* run("create_thread", args);
      assert.isTrue(retried.ok);
      assert.strictEqual(host.submissions.length, 1);
      assert.strictEqual(
        retried.ok && retried.value.submissionId,
        host.submissions[0]!.submissionId,
      );
      assert.strictEqual(host.dispatched.length, 1);
      const third = yield* run("create_thread", args);
      assert.deepStrictEqual(third, retried);
      assert.strictEqual(host.dispatched.length, 1);
    }),
  );

  it.effect("sends only to supervised threads and limits queued bridge items", () =>
    Effect.gen(function* () {
      const { host, run } = yield* setup();
      host.threads = [
        thread("t-full", "exposed", { runtimeMode: "full-access" }),
        thread("t-sup", "exposed"),
      ];
      const refused = yield* run("send_message", { threadId: "t-full", prompt: "Hi" });
      assert.include(!refused.ok ? refused.error.message : "", "not supervised");

      const submissionIds: string[] = [];
      for (let index = 0; index < AGENT_BRIDGE_LIMITS.queuedBridgeItemsPerThread; index += 1) {
        const sent = yield* run("send_message", { threadId: "t-sup", prompt: `Hi ${index}` });
        assert.isTrue(sent.ok);
        const command = host.submissions.at(-1)!;
        assert.strictEqual(command.intent, "queue-tail");
        assert.strictEqual(command.command.runtimeMode, "approval-required");
        submissionIds.push(sent.ok ? sent.value.submissionId : "");
      }
      host.queues.set("t-sup", {
        ...emptyQueue("t-sup"),
        items: submissionIds.map((submissionId) => ({ submissionId })),
      } as unknown as NextTurnQueueSnapshot);
      const limited = yield* run("send_message", { threadId: "t-sup", prompt: "One more" });
      assert.isFalse(limited.ok);
      assert.isDefined(!limited.ok ? limited.error.retryAfterSeconds : undefined);
    }),
  );

  it.effect("limits thread creation per client per hour and bridge threads globally", () =>
    Effect.gen(function* () {
      let now = 0;
      const { host, run } = yield* setup({ now: () => now });
      for (let index = 0; index < AGENT_BRIDGE_LIMITS.createThreadPerHour; index += 1) {
        const created = yield* run("create_thread", { projectId: "exposed", prompt: `${index}` });
        assert.isTrue(created.ok);
      }
      const limited = yield* run("create_thread", { projectId: "exposed", prompt: "more" });
      assert.isFalse(limited.ok);
      assert.strictEqual(!limited.ok && limited.error.retryAfterSeconds, 3600);

      now = 60 * 60 * 1000 + 1;
      // Four bridge-created threads are running: F5 is busy.
      host.threads = host.submissions
        .slice(0, AGENT_BRIDGE_LIMITS.runningBridgeThreadsGlobal)
        .map((submission) =>
          thread(submission.command.threadId, "exposed", {
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn"),
              state: "running",
              requestedAt: "2026-01-01T00:00:00.000Z",
              startedAt: null,
              completedAt: null,
              assistantMessageId: null,
            },
          }),
        );
      const busy = yield* run("create_thread", { projectId: "exposed", prompt: "busy" });
      assert.isFalse(busy.ok);
      assert.include(!busy.ok ? busy.error.message : "", "busy");
    }),
  );

  it.effect("reports preparing-worktree, blocked, and timed-out waits", () =>
    Effect.gen(function* () {
      const { host, run } = yield* setup();
      const created = yield* run("create_thread", { projectId: "exposed", prompt: "Hi" });
      assert.isTrue(created.ok);
      const { threadId, submissionId } = created.ok ? created.value : ({} as never);
      host.threads = [thread(threadId, "exposed")];
      host.records.clear();
      const item = { submissionId, status: "queued", lastErrorDetail: null };
      host.queues.set(threadId, {
        ...emptyQueue(threadId),
        items: [item],
        blockedKind: "waiting",
        reasonCode: "worktree_setup",
      } as unknown as NextTurnQueueSnapshot);
      const preparing = yield* run("wait_for_submission", { submissionId, timeoutSeconds: 0 });
      assert.deepInclude(preparing.ok ? preparing.value : {}, { status: "preparing-worktree" });

      host.queues.set(threadId, {
        ...emptyQueue(threadId),
        items: [item],
        paused: true,
        blockedKind: "paused",
        reasonCode: "manual_pause",
        reasonDetail: "Paused by you.",
      } as unknown as NextTurnQueueSnapshot);
      const blocked = yield* run("wait_for_submission", { submissionId, timeoutSeconds: 5 });
      assert.deepInclude(blocked.ok ? blocked.value : {}, {
        status: "blocked",
        reason: "Paused by you.",
        timedOut: false,
      });

      host.queues.set(threadId, {
        ...emptyQueue(threadId),
        items: [item],
      } as unknown as NextTurnQueueSnapshot);
      const fiber = yield* run("wait_for_submission", { submissionId, timeoutSeconds: 2 }).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust("3 seconds");
      const waited = yield* Fiber.join(fiber);
      assert.deepInclude(waited.ok ? waited.value : {}, { status: "queued" });

      const unknown = yield* run("wait_for_submission", {
        submissionId: "nope",
        timeoutSeconds: 0,
      });
      assert.isFalse(unknown.ok);
    }),
  );

  it.effect("wakes a waiter when the queue changes and is cancelled by interruption", () =>
    Effect.gen(function* () {
      const { host, run } = yield* setup();
      const created = yield* run("create_thread", { projectId: "exposed", prompt: "Hi" });
      const { threadId, submissionId } = created.ok ? created.value : ({} as never);
      host.threads = [thread(threadId, "exposed")];
      host.records.clear();
      host.queues.set(threadId, {
        ...emptyQueue(threadId),
        items: [{ submissionId, status: "queued", lastErrorDetail: null }],
      } as unknown as NextTurnQueueSnapshot);
      const fiber = yield* run("wait_for_submission", { submissionId, timeoutSeconds: 45 }).pipe(
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      host.queues.set(threadId, emptyQueue(threadId));
      host.records.set(submissionId, {
        submissionId: CommandId.makeUnsafe(submissionId),
        threadId: ThreadId.makeUnsafe(threadId),
        requestHash: "",
        itemId: null,
        messageId: "m",
        disposition: "rejected",
        resultSequence: null,
        reasonCode: "thread_deleted",
        createdAt: "",
        settledAt: "",
      });
      // Publish until the waiter's subscription is live; the poll interval never elapses here.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* PubSub.publish(host.queueChanges, ThreadId.makeUnsafe(threadId));
        yield* Effect.yieldNow;
      }
      const woken = yield* Fiber.join(fiber);
      assert.deepInclude(woken.ok ? woken.value : {}, { status: "rejected", timedOut: false });

      // Interrupting a wait (an HTTP disconnect) releases its waiter slot.
      host.records.delete(submissionId);
      host.queues.set(threadId, {
        ...emptyQueue(threadId),
        items: [{ submissionId, status: "queued", lastErrorDetail: null }],
      } as unknown as NextTurnQueueSnapshot);
      for (let round = 0; round < 3; round += 1) {
        const waiting = yield* run("wait_for_submission", {
          submissionId,
          timeoutSeconds: 45,
        }).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(waiting);
        const exit = yield* Fiber.await(waiting);
        assert.isTrue(Exit.hasInterrupts(exit));
      }
    }),
  );

  it.effect("re-checks access before resubmitting a pending receipt", () =>
    Effect.gen(function* () {
      const { host, run, caller } = yield* setup();
      host.threads = [thread("t-sup", "exposed")];
      const sendArgs = { threadId: "t-sup", prompt: "Hi", clientRequestId: "req-mode" };
      host.failNextBeforeAdmission = { message: "busy" };
      assert.isFalse((yield* run("send_message", sendArgs)).ok);
      host.threads = [thread("t-sup", "exposed", { runtimeMode: "full-access" })];
      const sent = yield* run("send_message", sendArgs);
      assert.deepInclude(sent.ok ? sent.value : {}, {
        disposition: "rejected",
        reason: "The thread is no longer supervised.",
      });

      const createArgs = { projectId: "exposed", prompt: "Hi", clientRequestId: "req-unshare" };
      host.failNextBeforeAdmission = { message: "busy" };
      assert.isFalse((yield* run("create_thread", createArgs)).ok);
      const unshared: AgentBridgeCaller = { ...caller, visibleProjectIds: new Set() };
      const created = yield* run("create_thread", createArgs, unshared);
      assert.deepInclude(created.ok ? created.value : {}, { disposition: "rejected" });
      assert.strictEqual(host.submissions.length, 0);
      const status = yield* run(
        "wait_for_submission",
        { submissionId: created.ok ? created.value.submissionId : "", timeoutSeconds: 0 },
        unshared,
      );
      assert.deepInclude(status.ok ? status.value : {}, { status: "rejected" });
    }),
  );

  it.effect("reports how an earlier submission's turn ended after a later turn starts", () =>
    Effect.gen(function* () {
      const { host, run } = yield* setup();
      host.threads = [thread("t-sup", "exposed")];
      const sent = yield* run("send_message", { threadId: "t-sup", prompt: "Hi" });
      const submissionId: string = sent.ok ? sent.value.submissionId : "";
      host.records.set(submissionId, startedRecord(submissionId, "t-sup", "m-1"));
      host.threads = [
        thread("t-sup", "exposed", {
          messages: [{ id: "m-1", turnId: "turn-1" }] as never,
          latestTurn: latestTurn("turn-2", "running"),
        }),
      ];
      for (const [state, status] of [
        ["error", "failed"],
        ["interrupted", "interrupted"],
        ["completed", "completed"],
      ] as const) {
        host.turnStates.set("turn-1", state);
        const result = yield* run("wait_for_submission", { submissionId, timeoutSeconds: 0 });
        assert.deepInclude(result.ok ? result.value : {}, { status, turnId: "turn-1" });
      }
    }),
  );

  it.effect("counts admitted submissions the queue does not show yet against the limits", () =>
    Effect.gen(function* () {
      const { host, run } = yield* setup();
      host.threads = [thread("t-sup", "exposed")];
      const burst = (count: number, call: (index: number) => ReturnType<typeof run>) =>
        Effect.gen(function* () {
          // Submissions stay in flight, so the queue never shows them.
          const gate = yield* Deferred.make<void>();
          host.submissionGate = gate;
          let refused = 0;
          const fibers = yield* Effect.forEach(
            Array.from({ length: count }, (_, index) => index),
            (index) =>
              call(index).pipe(
                Effect.tap((result) =>
                  Effect.sync(() => {
                    if (!result.ok) refused += 1;
                  }),
                ),
                Effect.forkChild,
              ),
          );
          for (let attempt = 0; attempt < 1_000 && refused < 2; attempt += 1)
            yield* Effect.yieldNow;
          yield* Deferred.succeed(gate, undefined);
          host.submissionGate = null;
          return yield* Effect.forEach(fibers, Fiber.join);
        });

      const perThread = AGENT_BRIDGE_LIMITS.queuedBridgeItemsPerThread;
      const sent = yield* burst(perThread + 2, (index) =>
        run("send_message", { threadId: "t-sup", prompt: `Hi ${index}` }),
      );
      assert.strictEqual(sent.filter((result) => result.ok).length, perThread);
      assert.include(
        sent.find((result) => !result.ok)?.error?.message ?? "",
        "may wait in one thread's queue",
      );

      const global = AGENT_BRIDGE_LIMITS.runningBridgeThreadsGlobal;
      const created = yield* burst(global + 2, (index) =>
        run("create_thread", { projectId: "exposed", prompt: `Task ${index}` }),
      );
      assert.strictEqual(created.filter((result) => result.ok).length, global);
      assert.include(created.find((result) => !result.ok)?.error?.message ?? "", "busy");
    }),
  );

  it.effect("ignores streamed output while waiting and maps the turn once", () =>
    Effect.gen(function* () {
      const { host, run } = yield* setup();
      host.threads = [thread("t-sup", "exposed")];
      const sent = yield* run("send_message", { threadId: "t-sup", prompt: "Hi" });
      const submissionId: string = sent.ok ? sent.value.submissionId : "";
      host.records.set(submissionId, startedRecord(submissionId, "t-sup", "m-1"));
      const running = (state: "running" | "completed") =>
        thread("t-sup", "exposed", {
          messages: [{ id: "m-1", turnId: "turn-1" }] as never,
          latestTurn: latestTurn("turn-1", state),
        });
      host.threads = [running("running")];
      const event = (type: string, payload: Record<string, unknown> = {}) =>
        ({ type, aggregateId: "t-sup", payload }) as unknown as OrchestrationEvent;
      const fiber = yield* run("wait_for_submission", { submissionId, timeoutSeconds: 45 }).pipe(
        Effect.forkChild,
      );
      // Publish until the waiter's subscription is live.
      const before = host.snapshotReads;
      for (let attempt = 0; attempt < 20 && host.snapshotReads <= before + 1; attempt += 1) {
        yield* PubSub.publish(host.domainEvents, event("thread.activity-appended"));
        yield* Effect.yieldNow;
      }
      assert.isAbove(host.snapshotReads, before + 1);

      const live = host.snapshotReads;
      for (let index = 0; index < 20; index += 1) {
        yield* PubSub.publish(host.domainEvents, event("thread.message-sent", { streaming: true }));
        yield* PubSub.publish(host.domainEvents, event("thread.command-execution-output-appended"));
        yield* Effect.yieldNow;
      }
      assert.strictEqual(host.snapshotReads, live);

      host.threads = [running("completed")];
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* PubSub.publish(host.domainEvents, event("thread.session-set"));
        yield* Effect.yieldNow;
      }
      const done = yield* Fiber.join(fiber);
      assert.deepInclude(done.ok ? done.value : {}, { status: "completed", timedOut: false });
      assert.strictEqual(host.detailReads, 1);
    }),
  );

  it("truncates on a UTF-8 boundary", () => {
    const value = truncateUtf8("ééé", 5);
    assert.deepStrictEqual(value, { text: "éé", truncated: true });
  });
});
