import { mkdirSync, writeFileSync } from "node:fs";
import * as nodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  MuseSettings,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Deferred, Effect, Fiber, Layer, Schema, ServiceMap, Stream } from "effect";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { openMspHost } from "../msp/MspSessionRuntime.ts";
import { memoryNativeCommandIdStore } from "../msp/nativeCommandIds.ts";
import { MockMspHost, mspError } from "../msp/testing/mockMspHost.ts";
import type { MuseAdapterShape } from "../Services/MuseAdapter.ts";
import { makeMuseAdapter, parseMuseResumeCursor } from "./MuseAdapter.ts";

const INSTANCE = ProviderInstanceId.make("muse");

interface Harness {
  readonly adapter: MuseAdapterShape;
  readonly hosts: MockMspHost[];
  configure: (host: MockMspHost) => void;
}

class MuseHarness extends ServiceMap.Service<MuseHarness, Harness>()(
  "t3/provider/Layers/MuseAdapter.test/MuseHarness",
) {}

const HarnessLayer = Layer.effect(
  MuseHarness,
  Effect.gen(function* () {
    const hosts: MockMspHost[] = [];
    const harness: { configure: (host: MockMspHost) => void } = { configure: () => undefined };
    const adapter = yield* makeMuseAdapter(Schema.decodeSync(MuseSettings)({}), {
      instanceId: INSTANCE,
      nativeCommandIds: memoryNativeCommandIdStore(),
      sessionOpenTimeoutMs: 1_000,
      openHost: () =>
        Effect.promise(async () => {
          const mock = new MockMspHost();
          harness.configure(mock);
          hosts.push(mock);
          const host = await openMspHost({ transport: mock.transport, clientVersion: "test" });
          return { host, stderrTail: () => "" };
        }),
    });
    return {
      adapter,
      hosts,
      get configure() {
        return harness.configure;
      },
      set configure(value) {
        harness.configure = value;
      },
    } satisfies Harness;
  }),
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-muse-adapter-" })),
  Layer.provideMerge(NodeServices.layer),
);

const tick = (ms = 20) => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)));

const collect = (adapter: MuseAdapterShape) =>
  Effect.gen(function* () {
    const events: ProviderRuntimeEvent[] = [];
    const fiber = yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.forkChild,
    );
    yield* tick(5);
    return { events, stop: Fiber.interrupt(fiber) };
  });

const start = (harness: Harness, threadId: ThreadId, runtimeMode = "auto-accept-edits" as const) =>
  harness.adapter.startSession({
    threadId,
    provider: "muse",
    cwd: process.cwd(),
    runtimeMode,
  });

it.layer(HarnessLayer)("MuseAdapter", (it) => {
  it.effect("drains final MSP output before its single terminal lifecycle event", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
        const mock = new MockMspHost();
        const adapter = yield* makeMuseAdapter(Schema.decodeSync(MuseSettings)({}), {
          instanceId: INSTANCE,
          nativeCommandIds: memoryNativeCommandIdStore(),
          nativeEventLogger: {
            filePath: "test-msp.log",
            close: () => Effect.void,
            write: (value) =>
              (value as { event?: { method?: string } }).event?.method === "item/delta"
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
                : Effect.void,
          },
          openHost: () =>
            Effect.gen(function* () {
              const host = yield* Effect.promise(() =>
                openMspHost({ transport: mock.transport, clientVersion: "test" }),
              );
              yield* Effect.addFinalizer(() => Effect.promise(() => host.close()));
              return { host, stderrTail: () => "final stderr" };
            }),
        });
        const { events, stop } = yield* collect(adapter);
        const threadId = ThreadId.make("msp-final-output");
        yield* adapter.startSession({
          threadId,
          provider: "muse",
          cwd: process.cwd(),
          runtimeMode: "auto-accept-edits",
        });
        yield* adapter.sendTurn({ threadId, input: "work" });
        mock.notify("turn/started", { turnId: "turn-1" });
        mock.notify("item/delta", { itemId: "final", delta: "last output" });
        yield* Deferred.await(entered);
        mock.end();
        yield* tick();
        assert.equal(events.filter((event) => event.type === "session.exited").length, 0);
        yield* Deferred.succeed(release, undefined);
        for (
          let attempt = 0;
          attempt < 100 && !events.some((event) => event.type === "session.exited");
          attempt++
        )
          yield* tick(1);
        const ordered = events.filter((event) =>
          ["content.delta", "turn.completed", "session.exited"].includes(event.type),
        );
        assert.deepEqual(
          ordered.map((event) => event.type),
          ["content.delta", "turn.completed", "session.exited"],
        );
        assert.equal(
          ordered[0]?.type === "content.delta" && ordered[0].payload.delta,
          "last output",
        );
        assert.isFalse(yield* adapter.hasSession(threadId));
        yield* stop;
      }),
    ),
  );

  it.effect("starts with verified permissions and maps the turn lifecycle", () =>
    Effect.gen(function* () {
      const harness = yield* MuseHarness;
      harness.configure = () => undefined;
      const { events, stop } = yield* collect(harness.adapter);
      const threadId = ThreadId.make("thread-lifecycle");
      const session = yield* start(harness, threadId);
      const host = harness.hosts.at(-1)!;
      assert.deepEqual(
        host.requestsFor("session/start")[0]?.params.approvalMode,
        "promptUnmatched",
      );
      assert.equal(
        host.requestsFor("session/setReasoningEffort")[0]?.params.reasoningEffort,
        "high",
      );
      assert.equal(parseMuseResumeCursor(session.resumeCursor)?.mspSessionId, "msp-session-1");

      const turn = yield* harness.adapter.sendTurn({ threadId, input: "hello" });
      assert.equal(turn.turnId, "turn-1");
      host.notify("turn/started", { turnId: "turn-1", commandId: "x" });
      host.notify("item/started", {
        item: {
          itemId: "a1",
          kind: "agentMessage",
          revision: 1,
          status: "inProgress",
          turnId: "turn-1",
          text: "",
        },
      });
      host.notify("item/delta", { itemId: "a1", delta: "Hel" });
      host.notify("item/updated", {
        item: {
          itemId: "a1",
          kind: "agentMessage",
          revision: 2,
          status: "inProgress",
          turnId: "turn-1",
          text: "Hel",
        },
      });
      // A stale revision must not be re-projected.
      host.notify("item/updated", {
        item: {
          itemId: "a1",
          kind: "agentMessage",
          revision: 1,
          status: "inProgress",
          turnId: "turn-1",
          text: "",
        },
      });
      host.notify("item/completed", {
        item: {
          itemId: "a1",
          kind: "agentMessage",
          revision: 3,
          status: "completed",
          turnId: "turn-1",
          text: "Hello",
        },
      });
      host.notify("session/todoListChanged", {
        items: [{ text: "step", status: "inProgress" }],
        revision: 1,
        sourceTool: "todo",
      });
      host.notify("turn/completed", { turnId: "turn-1", terminal: "completed" });
      yield* tick(50);

      const types = events.map((event) => event.type);
      assert.include(types, "turn.started");
      assert.include(types, "turn.plan.updated");
      assert.equal(types.filter((type) => type === "item.updated").length, 1, types.join(","));
      const deltas = events.filter((event) => event.type === "content.delta");
      assert.deepEqual(
        deltas.map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
        ["Hel", "lo"],
      );
      const completed = events.find((event) => event.type === "item.completed");
      assert.equal(completed?.type === "item.completed" ? completed.payload.detail : "", "Hello");
      const turnCompleted = events.find((event) => event.type === "turn.completed");
      assert.ok(turnCompleted?.resumeCursor);
      yield* stop;
      yield* harness.adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects approval-required through the unsupported-mode path", () =>
    Effect.gen(function* () {
      const harness = yield* MuseHarness;
      const result = yield* harness.adapter
        .startSession({
          threadId: ThreadId.make("thread-supervised"),
          provider: "muse",
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }),
  );

  it.effect("stops the session when the permission read-back mismatches", () =>
    Effect.gen(function* () {
      const harness = yield* MuseHarness;
      harness.configure = (host) => {
        (host.options as { forcedApprovalMode?: string }).forcedApprovalMode = "allowAll";
      };
      const threadId = ThreadId.make("thread-mismatch");
      const result = yield* start(harness, threadId).pipe(Effect.result);
      harness.configure = () => undefined;
      assert.equal(result._tag, "Failure");
      assert.isFalse(yield* harness.adapter.hasSession(threadId));
    }),
  );

  it.effect("stops when permissions diverge mid-session", () =>
    Effect.gen(function* () {
      const harness = yield* MuseHarness;
      const { events, stop } = yield* collect(harness.adapter);
      const threadId = ThreadId.make("thread-diverge");
      yield* start(harness, threadId);
      const host = harness.hosts.at(-1)!;
      host.notify("session/approvalModeChanged", {
        mode: "allowAll",
        clientName: "other",
        commandId: "c",
        source: "approvalReconfigure",
      });
      yield* tick(50);
      assert.isFalse(yield* harness.adapter.hasSession(threadId));
      assert.include(
        events.map((event) => event.type),
        "runtime.error",
      );
      yield* stop;
    }),
  );

  it.effect("maps approval choices, supersedes stages, and handles competing resolution", () =>
    Effect.gen(function* () {
      const harness = yield* MuseHarness;
      const { events, stop } = yield* collect(harness.adapter);
      const threadId = ThreadId.make("thread-approval");
      yield* start(harness, threadId);
      const host = harness.hosts.at(-1)!;
      const approval = {
        approvalId: "ap1",
        currentRequirementId: { approvalId: "ap1", sourceIndex: 0 },
        availableChoices: [
          { choiceId: "once", decision: "approved", scope: "once", label: "Allow once" },
          { choiceId: "no", decision: "denied", scope: "once", label: "Deny" },
        ],
        subject: { kind: "command", command: "make deploy" },
        toolName: "shell",
        turnId: "turn-1",
        itemId: "i",
        judgeEscalated: false,
        protectedWrite: false,
        rawArgs: "",
        taskId: "t",
        toolCallId: "tc",
      };
      host.notify("approval/requested", approval);
      yield* tick();
      host.notify("approval/updated", {
        approvalId: "ap1",
        availableChoices: approval.availableChoices,
        change: { kind: "nextStage" },
        currentRequirementId: { approvalId: "ap1", sourceIndex: 1 },
        subject: { kind: "command", command: "make deploy --prod" },
      });
      yield* tick();
      const opened = events.filter((event) => event.type === "request.opened");
      assert.equal(opened.length, 2);
      assert.equal(opened[1]?.requestId, "ap1#ap1:1");
      const first = opened[0];
      assert.deepEqual(first?.type === "request.opened" ? first.payload.approvalOptions : [], [
        { decision: "accept", label: "Allow once" },
        { decision: "decline", label: "Deny" },
      ]);

      yield* harness.adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make("ap1#ap1:1"),
        "accept",
      );
      const decide = host.requestsFor("approval/decide")[0]?.params;
      assert.equal(decide?.choiceId, "once");
      assert.deepEqual(decide?.requirementId, { approvalId: "ap1", sourceIndex: 1 });

      host.notify("approval/requested", {
        ...approval,
        approvalId: "ap2",
        currentRequirementId: { approvalId: "ap2", sourceIndex: 0 },
      });
      yield* tick();
      host.notify("approval/resolved", {
        approvalId: "ap2",
        decision: "denied",
        resolvedBy: "user",
        itemId: "i",
        policyResult: "deny",
        stageEvidence: [],
        turnId: "turn-1",
      });
      yield* tick();
      const late = yield* harness.adapter
        .respondToRequest(threadId, ApprovalRequestId.make("ap2#ap2:0"), "accept")
        .pipe(Effect.result);
      assert.equal(late._tag, "Failure");
      assert.match(late._tag === "Failure" ? late.failure.message : "", /already resolved/);
      yield* stop;
      yield* harness.adapter.stopSession(threadId);
    }),
  );

  it.effect("re-syncs on a stale requirement without retrying", () =>
    Effect.gen(function* () {
      const harness = yield* MuseHarness;
      const threadId = ThreadId.make("thread-stale");
      yield* start(harness, threadId);
      const host = harness.hosts.at(-1)!;
      host.notify("approval/requested", {
        approvalId: "ap1",
        currentRequirementId: { approvalId: "ap1", sourceIndex: 0 },
        availableChoices: [{ choiceId: "ok", decision: "approved", scope: "once", label: "OK" }],
        subject: { kind: "command" },
        toolName: "shell",
        turnId: "turn-1",
      });
      yield* tick();
      host.handlers.set("approval/decide", () => {
        throw mspError("approvalRequirementStale");
      });
      const result = yield* harness.adapter
        .respondToRequest(threadId, ApprovalRequestId.make("ap1#ap1:0"), "accept")
        .pipe(Effect.result);
      assert.match(result._tag === "Failure" ? result.failure.message : "", /approval changed/);
      assert.equal(host.requestsFor("approval/decide").length, 1);
      assert.isAtLeast(host.requestsFor("approval/listPending").length, 2);
      yield* harness.adapter.stopSession(threadId);
    }),
  );

  for (const parentActive of [false, true]) {
    it.effect(
      `keeps a workflow child's approval on its parent independently of the parent turn (${parentActive})`,
      () =>
        Effect.gen(function* () {
          const harness = yield* MuseHarness;
          const { events, stop } = yield* collect(harness.adapter);
          const threadId = ThreadId.make(`thread-child-approval-${parentActive}`);
          yield* start(harness, threadId);
          const host = harness.hosts.at(-1)!;
          if (parentActive)
            yield* harness.adapter.sendTurn({ threadId, input: "Run the workflow" });
          const approval = {
            approvalId: "child-approval",
            currentRequirementId: { approvalId: "child-approval", sourceIndex: 0 },
            availableChoices: [
              { choiceId: "once", decision: "approved", scope: "once", label: "Allow once" },
              { choiceId: "deny", decision: "denied", scope: "once", label: "Deny" },
            ],
            subject: { kind: "command", command: "make check" },
            toolName: "shell",
            turnId: "native-child-run",
            itemId: "child-item",
            judgeEscalated: false,
            protectedWrite: false,
            rawArgs: "",
            taskId: "child-task",
            toolCallId: "child-tool",
            subagentOrigin: {
              subagentId: "child-agent",
              childRunId: "native-child-run",
              childSessionId: "native-child-session",
            },
          };
          host.notify("approval/requested", approval);
          yield* tick();
          const opened = events.find((event) => event.type === "request.opened");
          assert.equal(opened?.threadId, threadId);
          assert.isUndefined(opened?.turnId);
          if (parentActive) {
            host.notify("turn/completed", { turnId: "turn-1", terminal: "completed" });
            yield* tick();
          }
          assert.equal(
            events.some((event) => event.type === "request.resolved"),
            false,
          );
          yield* harness.adapter.respondToRequest(
            threadId,
            ApprovalRequestId.make("child-approval#child-approval:0"),
            "accept",
          );
          assert.equal(host.requestsFor("approval/decide").at(-1)?.params.choiceId, "once");
          host.notify("approval/resolved", {
            ...approval,
            decision: "approved",
            resolvedBy: "user",
            policyResult: "allow",
            stageEvidence: [],
          });
          yield* tick();
          const resolved = events.find((event) => event.type === "request.resolved");
          assert.equal(resolved?.threadId, threadId);
          assert.isUndefined(resolved?.turnId);
          yield* stop;
          yield* harness.adapter.stopSession(threadId);
        }),
    );
  }

  it.effect("denies an undecodable approval when it can, otherwise stops", () =>
    Effect.gen(function* () {
      const harness = yield* MuseHarness;
      const threadId = ThreadId.make("thread-undecodable");
      yield* start(harness, threadId);
      const host = harness.hosts.at(-1)!;
      host.notify("approval/requested", {
        approvalId: "ap1",
        currentRequirementId: { approvalId: "ap1", sourceIndex: 0 },
        availableChoices: [{ choiceId: "deny", decision: "denied" }],
      });
      yield* tick(40);
      assert.equal(host.requestsFor("approval/decide")[0]?.params.choiceId, "deny");
      assert.isTrue(yield* harness.adapter.hasSession(threadId));
      host.notify("approval/requested", { approvalId: "ap2" });
      yield* tick(40);
      assert.isFalse(yield* harness.adapter.hasSession(threadId));
    }),
  );

  it.effect("classifies a rejected turn as not sent and retries it under a fresh native id", () =>
    Effect.gen(function* () {
      const harness = yield* MuseHarness;
      const threadId = ThreadId.make("thread-delivery");
      yield* start(harness, threadId);
      const host = harness.hosts.at(-1)!;
      host.handlers.set("turn/start", () => {
        throw mspError("commandRejected", "rejected", -32030);
      });
      const deliveryId = "delivery-1" as never;
      const first = yield* harness.adapter
        .sendTurn({ threadId, input: "hi", deliveryId })
        .pipe(Effect.result);
      assert.equal(first._tag, "Failure");
      const failure =
        first._tag === "Failure"
          ? (first.failure as { deliveryCertainty?: string; deliveryRetryable?: boolean })
          : {};
      assert.equal(failure.deliveryCertainty, "not_sent");
      assert.equal(failure.deliveryRetryable, false);
      host.handlers.delete("turn/start");
      yield* harness.adapter.sendTurn({ threadId, input: "hi", deliveryId });
      // The host answered the first attempt; reusing its id would replay the rejection.
      const commandIds = host.requestsFor("turn/start").map((request) => request.params.commandId);
      assert.equal(commandIds.length, 2);
      assert.notEqual(commandIds[0], commandIds[1]);
      yield* harness.adapter.stopSession(threadId);
    }),
  );

  it.effect("stopSession waits for the cancelled turn to settle", () =>
    Effect.gen(function* () {
      const harness = yield* MuseHarness;
      const threadId = ThreadId.make("thread-cancel");
      yield* start(harness, threadId);
      const host = harness.hosts.at(-1)!;
      yield* harness.adapter.sendTurn({ threadId, input: "work" });
      host.notify("turn/started", { turnId: "turn-1", commandId: "c" });
      yield* tick();
      host.handlers.set("turn/cancel", (params) => {
        setTimeout(
          () => host.notify("turn/completed", { turnId: "turn-1", terminal: "cancelled" }),
          30,
        );
        return { commandId: params.commandId, status: "accepted", turnId: "turn-1" };
      });
      const startedAt = Date.now();
      yield* harness.adapter.stopSession(threadId);
      assert.isAtLeast(Date.now() - startedAt, 25);
      assert.equal(host.requestsFor("turn/cancel").length, 1);
    }),
  );

  it.effect("starts fresh only on sessionNotFound and warns", () =>
    Effect.gen(function* () {
      const harness = yield* MuseHarness;
      harness.configure = (host) => {
        host.handlers.set("session/resume", () => {
          throw mspError("sessionNotFound");
        });
      };
      const { events, stop } = yield* collect(harness.adapter);
      const threadId = ThreadId.make("thread-resume");
      yield* harness.adapter.startSession({
        threadId,
        provider: "muse",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: {
          schemaVersion: 1,
          mspSessionId: "old",
          viewCursor: "c9",
          durability: "durable",
        },
      });
      harness.configure = () => undefined;
      const host = harness.hosts.at(-1)!;
      assert.equal(host.requestsFor("session/start").length, 1);
      assert.ok(
        events.some(
          (event) =>
            event.type === "runtime.warning" && /new Muse Code session/.test(event.payload.message),
        ),
      );
      yield* stop;
      yield* harness.adapter.stopSession(threadId);
    }),
  );

  it.effect("selects the runtime mode's permission profile on start and resume", () =>
    Effect.gen(function* () {
      const harness = yield* MuseHarness;
      harness.configure = () => undefined;
      const supervised = ThreadId.make("thread-profile-start");
      yield* start(harness, supervised);
      assert.equal(
        harness.hosts.at(-1)!.requestsFor("session/start")[0]?.params.permissionProfile,
        ":ask-me",
      );
      yield* harness.adapter.stopSession(supervised);

      const resumed = ThreadId.make("thread-profile-resume");
      yield* harness.adapter.startSession({
        threadId: resumed,
        provider: "muse",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: {
          schemaVersion: 1,
          mspSessionId: "msp-session-1",
          viewCursor: "c1",
          durability: "durable",
        },
      });
      assert.equal(
        harness.hosts.at(-1)!.requestsFor("session/resume")[0]?.params.permissionProfile,
        ":unrestricted",
      );
      yield* harness.adapter.stopSession(resumed);

      // An ephemeral host refuses any profile id, so none is sent.
      harness.configure = (host) => {
        Object.assign(host.options, { sessionDurability: "ephemeral" });
      };
      const ephemeral = ThreadId.make("thread-profile-ephemeral");
      yield* start(harness, ephemeral);
      harness.configure = () => undefined;
      const params = harness.hosts.at(-1)!.requestsFor("session/start")[0]?.params;
      assert.equal(params?.approvalMode, "promptUnmatched");
      assert.equal(params?.permissionProfile, undefined);
      yield* harness.adapter.stopSession(ephemeral);
    }),
  );

  it.effect("hydrates from session/read when the resume anchor was pruned", () =>
    Effect.gen(function* () {
      const harness = yield* MuseHarness;
      let resumes = 0;
      harness.configure = (host) => {
        host.handlers.set("session/resume", () => {
          resumes += 1;
          if (resumes === 1) throw mspError("boundaryPruned");
          return {
            session: { sessionId: host.sessionId, status: "idle", turnCount: 1 },
            history: { items: null, mode: "none", snapshot: null },
            pendingRequests: [],
            viewCursor: host.nextCursor(),
          };
        });
        host.handlers.set("session/read", () => ({
          session: { sessionId: host.sessionId },
          history: {
            items: [
              {
                itemId: "old",
                kind: "agentMessage",
                revision: 2,
                status: "completed",
                turnId: "t0",
                text: "Earlier",
              },
            ],
            mode: "inline",
            snapshot: null,
          },
          pendingRequests: [],
          viewCursor: "cursor-read",
        }));
      };
      const { events, stop } = yield* collect(harness.adapter);
      const threadId = ThreadId.make("thread-pruned");
      yield* harness.adapter.startSession({
        threadId,
        provider: "muse",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: {
          schemaVersion: 1,
          mspSessionId: "msp-session-1",
          viewCursor: "gone",
          durability: "durable",
        },
      });
      harness.configure = () => undefined;
      assert.ok(events.some((event) => event.type === "runtime.warning"));
      const hydrated = events.find((event) => event.type === "item.completed");
      assert.equal(hydrated?.itemId, "old");
      assert.equal(harness.hosts.at(-1)!.requestsFor("session/start").length, 0);
      yield* stop;
      yield* harness.adapter.stopSession(threadId);
    }),
  );

  it.effect("reopens pending approvals after resume", () =>
    Effect.gen(function* () {
      const harness = yield* MuseHarness;
      harness.configure = (host) => {
        host.handlers.set("approval/listPending", () => ({
          approvals: [
            {
              approvalId: "ap9",
              currentRequirementId: { approvalId: "ap9", sourceIndex: 0 },
              availableChoices: [
                { choiceId: "ok", decision: "approved", scope: "once", label: "OK" },
              ],
              subject: { kind: "command" },
              toolName: "shell",
              turnId: "t1",
            },
          ],
          userInputs: [],
        }));
      };
      const { events, stop } = yield* collect(harness.adapter);
      const threadId = ThreadId.make("thread-reopen");
      yield* harness.adapter.startSession({
        threadId,
        provider: "muse",
        cwd: process.cwd(),
        runtimeMode: "auto-accept-edits",
        resumeCursor: {
          schemaVersion: 1,
          mspSessionId: "msp-session-1",
          viewCursor: "c1",
          durability: "durable",
        },
      });
      harness.configure = () => undefined;
      assert.ok(
        events.some((event) => event.type === "request.opened" && event.requestId === "ap9#ap9:0"),
      );
      yield* stop;
      yield* harness.adapter.stopSession(threadId);
    }),
  );

  it.effect("re-applies effort after resume and on change", () =>
    Effect.gen(function* () {
      const harness = yield* MuseHarness;
      const threadId = ThreadId.make("thread-effort");
      yield* harness.adapter.startSession({
        threadId,
        provider: "muse",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: INSTANCE,
          model: "muse-spark-1.3",
          options: [{ id: "reasoningEffort", value: "low" }],
        },
        resumeCursor: {
          schemaVersion: 1,
          mspSessionId: "msp-session-1",
          viewCursor: "c1",
          durability: "durable",
        },
      });
      const host = harness.hosts.at(-1)!;
      yield* harness.adapter.sendTurn({
        threadId,
        input: "go",
        modelSelection: {
          instanceId: INSTANCE,
          model: "muse-spark-1.3",
          options: [{ id: "reasoningEffort", value: "medium" }],
        },
      });
      assert.deepEqual(
        host
          .requestsFor("session/setReasoningEffort")
          .map((request) => request.params.reasoningEffort),
        ["low", "medium"],
      );
      yield* harness.adapter.stopSession(threadId);
    }),
  );

  it.effect("interrupts the active turn", () =>
    Effect.gen(function* () {
      const harness = yield* MuseHarness;
      const threadId = ThreadId.make("thread-interrupt");
      yield* start(harness, threadId);
      const host = harness.hosts.at(-1)!;
      yield* harness.adapter.sendTurn({ threadId, input: "go" });
      yield* harness.adapter.interruptTurn(threadId, TurnId.make("turn-1"));
      assert.equal(host.requestsFor("turn/interrupt")[0]?.params.turnId, "turn-1");
      yield* harness.adapter.stopSession(threadId);
    }),
  );

  it.effect("sends images inline as the SDK contract requires, with a stable payload", () =>
    Effect.gen(function* () {
      const harness = yield* MuseHarness;
      const config = yield* ServerConfig;
      const attachment = {
        type: "image" as const,
        id: "thread-muse-image-12345678-1234-1234-1234-123456789abc",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const attachmentPath = nodePath.join(
        config.attachmentsDir,
        attachmentRelativePath(attachment),
      );
      mkdirSync(nodePath.dirname(attachmentPath), { recursive: true });
      writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));
      const threadId = ThreadId.make("thread-image");
      yield* start(harness, threadId);
      const host = harness.hosts.at(-1)!;
      yield* harness.adapter.sendTurn({ threadId, input: "look", attachments: [attachment] });
      host.notify("turn/completed", { turnId: "turn-1", terminal: "completed" });
      yield* tick();
      yield* harness.adapter.sendTurn({ threadId, input: "look", attachments: [attachment] });
      assert.equal(host.requestsFor("media/upload").length, 0);
      const inputs = host.requestsFor("turn/start").map((request) => request.params.input);
      assert.deepEqual(inputs[0], [
        { type: "text", text: "look" },
        {
          type: "image",
          mediaType: "image/png",
          base64Data: Buffer.from([1, 2, 3, 4]).toString("base64"),
        },
      ]);
      assert.deepEqual(inputs[1], inputs[0]);
      yield* harness.adapter.stopSession(threadId);
    }),
  );

  it.effect("projects a terminal event and approvals recovered by gap fill", () =>
    Effect.gen(function* () {
      const harness = yield* MuseHarness;
      const { events, stop } = yield* collect(harness.adapter);
      const threadId = ThreadId.make("thread-gap");
      yield* start(harness, threadId);
      const host = harness.hosts.at(-1)!;
      yield* harness.adapter.sendTurn({ threadId, input: "go" });
      host.notify("turn/started", { turnId: "turn-1", commandId: "c" });
      yield* tick();
      const after = `cursor-${host.cursorCounter}`;
      const missed = (method: string, viewCursor: string, params: Record<string, unknown>) => ({
        method,
        params: { sessionId: host.sessionId, viewCursor, ...params },
      });
      host.handlers.set("view/page", () => ({
        events: [
          missed("item/completed", "gap-1", {
            item: {
              itemId: "a1",
              kind: "agentMessage",
              revision: 1,
              status: "completed",
              turnId: "turn-1",
              text: "Done",
            },
          }),
          missed("turn/completed", "gap-2", { turnId: "turn-1", terminal: "completed" }),
        ],
        nextCursor: "gap-2",
      }));
      host.handlers.set("approval/listPending", () => ({
        approvals: [
          {
            approvalId: "ap-gap",
            currentRequirementId: { approvalId: "ap-gap", sourceIndex: 0 },
            availableChoices: [
              { choiceId: "ok", decision: "approved", scope: "once", label: "OK" },
            ],
            subject: { kind: "command" },
            toolName: "shell",
            turnId: "turn-1",
          },
        ],
        userInputs: [],
      }));
      host.notify("view/gap", { after, next: "gap-2" });
      yield* tick(200);
      assert.ok(host.requestsFor("view/page").length >= 1);
      const completed = events.find(
        (event) => event.type === "turn.completed" && event.turnId === "turn-1",
      );
      assert.equal(
        completed?.type === "turn.completed" ? completed.payload.state : "",
        "completed",
      );
      assert.ok(events.some((event) => event.type === "item.completed" && event.itemId === "a1"));
      assert.ok(
        events.some(
          (event) => event.type === "request.opened" && event.requestId === "ap-gap#ap-gap:0",
        ),
      );
      const [session] = (yield* harness.adapter.listSessions()).filter(
        (entry) => entry.threadId === threadId,
      );
      assert.equal(session?.status, "ready");
      yield* stop;
      yield* harness.adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps a turn whose retract was declined and settles an accepted one", () =>
    Effect.gen(function* () {
      const harness = yield* MuseHarness;
      const { events, stop } = yield* collect(harness.adapter);
      const threadId = ThreadId.make("thread-retract");
      yield* start(harness, threadId);
      const host = harness.hosts.at(-1)!;
      yield* harness.adapter.sendTurn({ threadId, input: "one" });
      host.notify("turn/started", { turnId: "turn-1", commandId: "c1" });
      host.notify("turn/retracted", { turnId: "turn-1", commandId: "c1", outcome: "declined" });
      yield* tick();
      assert.isFalse(events.some((event) => event.type === "turn.aborted"));
      yield* harness.adapter.interruptTurn(threadId, TurnId.make("turn-1"));
      assert.equal(host.requestsFor("turn/interrupt").length, 1);
      host.notify("turn/completed", { turnId: "turn-1", terminal: "cancelled" });
      yield* tick();
      assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);

      yield* harness.adapter.sendTurn({ threadId, input: "two" });
      host.notify("turn/started", { turnId: "turn-2", commandId: "c2" });
      host.notify("turn/retracted", { turnId: "turn-2", commandId: "c2" });
      yield* tick();
      assert.ok(events.some((event) => event.type === "turn.aborted" && event.turnId === "turn-2"));
      const [session] = (yield* harness.adapter.listSessions()).filter(
        (entry) => entry.threadId === threadId,
      );
      assert.equal(session?.status, "ready");
      yield* stop;
      yield* harness.adapter.stopSession(threadId);
    }),
  );

  it.effect("refuses new work once permissions diverge and settles the active turn", () =>
    Effect.gen(function* () {
      const harness = yield* MuseHarness;
      const { events, stop } = yield* collect(harness.adapter);
      const threadId = ThreadId.make("thread-diverge-active");
      yield* start(harness, threadId);
      const host = harness.hosts.at(-1)!;
      host.handlers.set("turn/interrupt", (params) => {
        setTimeout(
          () => host.notify("turn/completed", { turnId: "turn-1", terminal: "cancelled" }),
          20,
        );
        return { commandId: params.commandId, status: "accepted", turnId: "turn-1" };
      });
      yield* harness.adapter.sendTurn({ threadId, input: "go" });
      host.notify("turn/started", { turnId: "turn-1", commandId: "c" });
      yield* tick();
      const startedAt = Date.now();
      host.notify("session/approvalModeChanged", {
        mode: "allowAll",
        clientName: "other",
        commandId: "c",
        source: "approvalReconfigure",
      });
      yield* tick(5);
      const refused = yield* harness.adapter
        .sendTurn({ threadId, input: "more" })
        .pipe(Effect.result);
      assert.equal(refused._tag, "Failure");
      assert.match(refused._tag === "Failure" ? refused.failure.message : "", /permissions/);
      yield* tick(200);
      assert.isFalse(yield* harness.adapter.hasSession(threadId));
      assert.isBelow(Date.now() - startedAt, 2_000);
      const completed = events.find((event) => event.type === "turn.completed");
      assert.equal(
        completed?.type === "turn.completed" ? completed.payload.state : "",
        "cancelled",
      );
      assert.equal(host.requestsFor("turn/start").length, 1);
      yield* stop;
    }),
  );

  it.effect("fails a session start the host never answers", () =>
    Effect.gen(function* () {
      const harness = yield* MuseHarness;
      harness.configure = (host) => {
        host.handlers.set("session/start", () => new Promise<never>(() => undefined));
      };
      const threadId = ThreadId.make("thread-hung-start");
      const result = yield* start(harness, threadId).pipe(Effect.result);
      harness.configure = () => undefined;
      assert.equal(result._tag, "Failure");
      assert.match(result._tag === "Failure" ? result.failure.message : "", /timed out/);
      assert.isFalse(yield* harness.adapter.hasSession(threadId));
      // The thread lock was released.
      yield* start(harness, threadId);
      yield* harness.adapter.stopSession(threadId);
    }),
  );

  it.effect("switches a resumed session to the requested model", () =>
    Effect.gen(function* () {
      const harness = yield* MuseHarness;
      const threadId = ThreadId.make("thread-resume-model");
      const selection = { instanceId: INSTANCE, model: "muse-other" };
      const session = yield* harness.adapter.startSession({
        threadId,
        provider: "muse",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: selection,
        resumeCursor: {
          schemaVersion: 1,
          mspSessionId: "msp-session-1",
          viewCursor: "c1",
          durability: "durable",
        },
      });
      const host = harness.hosts.at(-1)!;
      assert.deepEqual(
        host.requestsFor("session/setModel").map((request) => request.params.model),
        [{ modelId: "muse-other" }],
      );
      assert.equal(session.model, "muse-other");
      yield* harness.adapter.sendTurn({ threadId, input: "go", modelSelection: selection });
      assert.equal(host.requestsFor("session/setModel").length, 1);
      yield* harness.adapter.stopSession(threadId);
    }),
  );

  it.effect("reports a failure before turn/start as not sent", () =>
    Effect.gen(function* () {
      const harness = yield* MuseHarness;
      const threadId = ThreadId.make("thread-pre-turn");
      yield* start(harness, threadId);
      const host = harness.hosts.at(-1)!;
      host.handlers.set("session/setModel", () => {
        throw mspError("modelNotFound");
      });
      const result = yield* harness.adapter
        .sendTurn({
          threadId,
          input: "go",
          modelSelection: { instanceId: INSTANCE, model: "muse-missing" },
        })
        .pipe(Effect.result);
      const failure =
        result._tag === "Failure"
          ? (result.failure as { deliveryCertainty?: string; deliveryRetryable?: boolean })
          : {};
      assert.equal(failure.deliveryCertainty, "not_sent");
      assert.equal(failure.deliveryRetryable, false);
      assert.equal(host.requestsFor("turn/start").length, 0);
      yield* harness.adapter.stopSession(threadId);
    }),
  );
});
