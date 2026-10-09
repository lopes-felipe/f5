import { assert, it } from "@effect/vitest";
import { ThreadId, type PreviewAutomationRequest } from "@t3tools/contracts";
import { Effect, Exit, Option } from "effect";
import { afterEach, vi } from "vitest";

import { DISABLED_AGENT_BROWSER_POLICY } from "./browserAccess.ts";
import {
  makePreviewAutomationBroker,
  MAX_QUEUED_MUTATIONS_PER_THREAD,
} from "./PreviewAutomationBroker.ts";

afterEach(() => vi.restoreAllMocks());

it.effect("routes requests to the focused owner and correlates responses", () =>
  Effect.gen(function* () {
    const broker = makePreviewAutomationBroker();
    const threadId = ThreadId.makeUnsafe("thread-preview");
    const seenOperations: string[] = [];

    yield* broker.reportOwner(
      {
        clientId: "client-1",
        threadId,
        tabId: null,
        visible: true,
        supportsAutomation: true,
        focusedAt: "2026-06-23T10:00:00.000Z",
      },
      {
        clientId: "client-1",
        send: (request) =>
          Effect.sync(() => {
            seenOperations.push(request.operation);
            void Effect.runPromise(
              broker.respond(
                {
                  requestId: request.requestId,
                  clientId: request.clientId,
                  connectionId: request.connectionId,
                  ok: true,
                  result: { available: true },
                },
                new Set(["client-1"]),
              ),
            );
            return true;
          }),
      },
    );

    const result = yield* broker.invoke<{ available: boolean }>({
      threadId,
      operation: "status",
      input: {},
    });

    assert.deepEqual(result, { available: true });
    assert.deepEqual(seenOperations, ["status"]);
  }),
);

it.effect("prefers a visible owner over a more recently renewed hidden owner", () =>
  Effect.gen(function* () {
    const broker = makePreviewAutomationBroker();
    const threadId = ThreadId.makeUnsafe("thread-preview");
    const selected: string[] = [];
    const register = (clientId: string, visible: boolean, focusedAt: string) =>
      broker.reportOwner(
        {
          clientId,
          threadId,
          tabId: null,
          visible,
          supportsAutomation: true,
          focusedAt,
        },
        {
          clientId,
          send: (request) =>
            Effect.sync(() => {
              selected.push(clientId);
              void Effect.runPromise(
                broker.respond(
                  {
                    requestId: request.requestId,
                    clientId: request.clientId,
                    connectionId: request.connectionId,
                    ok: true,
                    result: { available: true },
                  },
                  new Set([clientId]),
                ),
              );
              return true;
            }),
        },
      );

    yield* register("visible-client", true, "2026-06-23T10:00:00.000Z");
    yield* register("hidden-client", false, "2026-06-23T10:01:00.000Z");
    yield* broker.invoke({ threadId, operation: "status", input: {} });

    assert.deepEqual(selected, ["visible-client"]);
  }),
);

it.effect("rejects when no focused owner exists", () =>
  Effect.gen(function* () {
    const broker = makePreviewAutomationBroker();
    const result = yield* Effect.exit(
      broker.invoke({
        threadId: ThreadId.makeUnsafe("thread-preview"),
        operation: "status",
        input: {},
      }),
    );

    assert.equal(result._tag, "Failure");
    if (Exit.isFailure(result)) {
      const error = Exit.findErrorOption(result);
      assert.equal(Option.isSome(error), true);
      if (Option.isSome(error)) {
        assert.equal(error.value._tag, "PreviewAutomationNoFocusedOwnerError");
      }
    }
  }),
);

it.effect("times out pending requests that are delivered but never answered", () =>
  Effect.gen(function* () {
    const broker = makePreviewAutomationBroker();
    const threadId = ThreadId.makeUnsafe("thread-preview");

    yield* broker.reportOwner(
      {
        clientId: "client-1",
        threadId,
        tabId: null,
        visible: true,
        supportsAutomation: true,
        focusedAt: "2026-06-23T10:00:00.000Z",
      },
      {
        clientId: "client-1",
        send: () => Effect.succeed(true),
      },
    );

    const result = yield* Effect.exit(
      broker.invoke({
        threadId,
        operation: "status",
        input: {},
        timeoutMs: 1,
      }),
    );

    assert.equal(result._tag, "Failure");
    if (Exit.isFailure(result)) {
      const error = Exit.findErrorOption(result);
      assert.equal(Option.isSome(error), true);
      if (Option.isSome(error)) {
        assert.equal(error.value._tag, "PreviewAutomationTimeoutError");
      }
    }
  }),
);

it.effect("fails in-flight pending requests when an owner is cleared", () =>
  Effect.gen(function* () {
    const broker = makePreviewAutomationBroker();
    const threadId = ThreadId.makeUnsafe("thread-preview");
    let capturedRequestId: string | null = null;

    yield* broker.reportOwner(
      {
        clientId: "client-1",
        threadId,
        tabId: null,
        visible: true,
        supportsAutomation: true,
        focusedAt: "2026-06-23T10:00:00.000Z",
      },
      {
        clientId: "client-1",
        send: (request) =>
          Effect.sync(() => {
            capturedRequestId = request.requestId;
            return true;
          }),
      },
    );

    const pending = Effect.runPromiseExit(
      broker.invoke({
        threadId,
        operation: "status",
        input: {},
      }),
    );

    while (capturedRequestId === null) {
      yield* Effect.sleep("1 millis");
    }
    yield* broker.clearOwner("client-1");

    const result = yield* Effect.promise(() => pending);
    assert.equal(result._tag, "Failure");
    if (Exit.isFailure(result)) {
      const error = Exit.findErrorOption(result);
      assert.equal(Option.isSome(error), true);
      if (Option.isSome(error)) {
        assert.equal(error.value._tag, "PreviewAutomationUnavailableError");
      }
    }
  }),
);

it.effect("preserves pending requests and tab affinity when an owner renews as hidden", () =>
  Effect.gen(function* () {
    const broker = makePreviewAutomationBroker();
    const threadId = ThreadId.makeUnsafe("thread-preview-renew-hidden");
    let captured: PreviewAutomationRequest | null = null;
    const client = {
      clientId: "client-1",
      send: (request: PreviewAutomationRequest) =>
        Effect.sync(() => {
          captured = request;
          return true;
        }),
    };
    const registration = yield* broker.reportOwner(
      {
        clientId: "client-1",
        threadId,
        tabId: "tab-1",
        visible: true,
        supportsAutomation: true,
        focusedAt: "2026-06-23T10:00:00.000Z",
      },
      client,
    );
    const pending = Effect.runPromise(
      broker.invoke<{ available: boolean }>({ threadId, operation: "status", input: {} }),
    );
    while (!captured) yield* Effect.sleep("1 millis");

    const renewed = yield* broker.reportOwner(
      {
        clientId: "client-1",
        connectionId: registration.connectionId,
        threadId,
        tabId: "tab-1",
        visible: false,
        supportsAutomation: true,
        focusedAt: "2026-06-23T10:01:00.000Z",
      },
      client,
    );
    const request = captured as PreviewAutomationRequest;
    yield* broker.respond(
      {
        requestId: request.requestId,
        clientId: request.clientId,
        connectionId: request.connectionId,
        ok: true,
        result: { available: true },
      },
      new Set(["client-1"]),
    );

    assert.equal(renewed.connectionId, registration.connectionId);
    assert.deepEqual(yield* Effect.promise(() => pending), { available: true });
  }),
);

it.effect("ignores responses from clients that did not receive the request", () =>
  Effect.gen(function* () {
    const broker = makePreviewAutomationBroker();
    const threadId = ThreadId.makeUnsafe("thread-preview");
    let capturedRequestId: string | null = null;

    yield* broker.reportOwner(
      {
        clientId: "client-1",
        threadId,
        tabId: null,
        visible: true,
        supportsAutomation: true,
        focusedAt: "2026-06-23T10:00:00.000Z",
      },
      {
        clientId: "client-1",
        send: (request) =>
          Effect.sync(() => {
            capturedRequestId = request.requestId;
            void Effect.runPromise(
              broker.respond(
                {
                  requestId: request.requestId,
                  clientId: request.clientId,
                  connectionId: request.connectionId,
                  ok: true,
                  result: { available: true },
                },
                new Set(["client-1"]),
              ),
            );
            return true;
          }),
      },
    );

    const pending = Effect.runPromise(
      broker.invoke<{ available: boolean }>({
        threadId,
        operation: "status",
        input: {},
      }),
    );

    while (capturedRequestId === null) {
      yield* Effect.sleep("1 millis");
    }
    yield* broker.respond(
      {
        requestId: capturedRequestId,
        ok: true,
        result: { available: false },
      },
      new Set(["client-2"]),
    );

    const result = yield* Effect.promise(() => pending);
    assert.deepEqual(result, { available: true });
  }),
);

it.effect("requires the full client and connection identity on responses", () =>
  Effect.gen(function* () {
    const broker = makePreviewAutomationBroker();
    const threadId = ThreadId.makeUnsafe("thread-preview");
    let captured: PreviewAutomationRequest | null = null;
    yield* broker.reportOwner(
      {
        clientId: "renderer-1",
        threadId,
        tabId: null,
        visible: true,
        supportsAutomation: true,
        focusedAt: "2026-06-23T10:00:00.000Z",
      },
      {
        clientId: "server-client-1",
        rendererClientId: "renderer-1",
        send: (request) => Effect.sync(() => ((captured = request), true)),
      },
    );
    const pending = Effect.runPromise(
      broker.invoke<{ accepted: boolean }>({ threadId, operation: "status", input: {} }),
    );
    while (!captured) yield* Effect.sleep("1 millis");
    const request = captured as PreviewAutomationRequest;
    yield* broker.respond(
      {
        requestId: request.requestId,
        clientId: "renderer-1",
        connectionId: "stale-connection",
        ok: true,
        result: { accepted: false },
      },
      new Set(["server-client-1"]),
    );
    yield* broker.respond(
      {
        requestId: request.requestId,
        clientId: request.clientId,
        connectionId: request.connectionId,
        ok: true,
        result: { accepted: true },
      },
      new Set(["server-client-1"]),
    );
    assert.deepEqual(yield* Effect.promise(() => pending), { accepted: true });
  }),
);

it.effect("gates operations by negotiated capability", () =>
  Effect.gen(function* () {
    const broker = makePreviewAutomationBroker();
    const threadId = ThreadId.makeUnsafe("thread-preview");
    yield* broker.reportOwner(
      {
        clientId: "client-1",
        threadId,
        tabId: null,
        visible: true,
        supportsAutomation: true,
        capabilities: ["automation"],
        focusedAt: "2026-06-23T10:00:00.000Z",
      },
      { clientId: "client-1", send: () => Effect.succeed(true) },
    );

    const result = yield* Effect.exit(
      broker.invoke({ threadId, operation: "screenshot", input: {} }),
    );
    assert.equal(result._tag, "Failure");
    if (Exit.isFailure(result)) {
      const error = Exit.findErrorOption(result);
      assert.equal(
        Option.isSome(error) && error.value._tag,
        "PreviewAutomationNoFocusedOwnerError",
      );
    }
  }),
);

it.effect("expires owners whose lease is not renewed", () =>
  Effect.gen(function* () {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const broker = makePreviewAutomationBroker();
    const threadId = ThreadId.makeUnsafe("thread-preview");
    yield* broker.reportOwner(
      {
        clientId: "client-1",
        threadId,
        tabId: null,
        visible: true,
        supportsAutomation: true,
        focusedAt: "2026-06-23T10:00:00.000Z",
      },
      { clientId: "client-1", send: () => Effect.succeed(true) },
    );
    now += 31_000;
    const result = yield* Effect.exit(broker.invoke({ threadId, operation: "status", input: {} }));
    assert.equal(result._tag, "Failure");
    if (Exit.isFailure(result)) {
      const error = Exit.findErrorOption(result);
      assert.equal(
        Option.isSome(error) && error.value._tag,
        "PreviewAutomationNoFocusedOwnerError",
      );
    }
  }),
);

it.effect(
  "keeps an automation session on its assigned tab unless an explicit tab overrides it",
  () =>
    Effect.gen(function* () {
      const broker = makePreviewAutomationBroker();
      const threadId = ThreadId.makeUnsafe("thread-preview");
      const seenTabs: Array<string | undefined> = [];
      yield* broker.reportOwner(
        {
          clientId: "client-1",
          threadId,
          tabId: "tab-active",
          visible: true,
          supportsAutomation: true,
          focusedAt: "2026-06-23T10:00:00.000Z",
        },
        {
          clientId: "client-1",
          send: (request) =>
            Effect.sync(() => {
              seenTabs.push(request.tabId);
              void Effect.runPromise(
                broker.respond(
                  {
                    requestId: request.requestId,
                    clientId: request.clientId,
                    connectionId: request.connectionId,
                    ok: true,
                    result:
                      request.operation === "open"
                        ? { tabId: "tab-session", available: true }
                        : { tabId: request.tabId, available: true },
                  },
                  new Set(["client-1"]),
                ),
              );
              return true;
            }),
        },
      );

      yield* broker.invoke({
        threadId,
        automationSessionId: "session-a",
        operation: "open",
        input: {},
      });
      yield* broker.invoke({
        threadId,
        automationSessionId: "session-a",
        operation: "navigate",
        input: {},
      });
      yield* broker.invoke({
        threadId,
        automationSessionId: "session-a",
        tabId: "tab-explicit",
        operation: "status",
        input: {},
      });

      assert.deepEqual(seenTabs, ["tab-active", "tab-session", "tab-explicit"]);
    }),
);

it.effect("drops automation-session affinity when its preview tab closes", () =>
  Effect.gen(function* () {
    const broker = makePreviewAutomationBroker();
    const threadId = ThreadId.makeUnsafe("thread-preview-close-target");
    const seenTabs: Array<string | undefined> = [];
    yield* broker.reportOwner(
      {
        clientId: "client-1",
        threadId,
        tabId: "tab-active",
        visible: true,
        supportsAutomation: true,
        focusedAt: "2026-06-23T10:00:00.000Z",
      },
      {
        clientId: "client-1",
        send: (request) =>
          Effect.sync(() => {
            seenTabs.push(request.tabId);
            void Effect.runPromise(
              broker.respond(
                {
                  requestId: request.requestId,
                  clientId: request.clientId,
                  connectionId: request.connectionId,
                  ok: true,
                  result:
                    request.operation === "open"
                      ? { tabId: "tab-session", available: true }
                      : { available: true },
                },
                new Set(["client-1"]),
              ),
            );
            return true;
          }),
      },
    );

    yield* broker.invoke({
      threadId,
      automationSessionId: "session-a",
      operation: "open",
      input: {},
    });
    yield* broker.invoke({
      threadId,
      automationSessionId: "session-a",
      operation: "click",
      input: {},
    });
    yield* broker.clearTargets(threadId, "tab-session");
    yield* broker.invoke({
      threadId,
      automationSessionId: "session-a",
      operation: "click",
      input: {},
    });

    assert.deepEqual(seenTabs, ["tab-active", "tab-session", "tab-active"]);
  }),
);

it.effect("renews the same lease but replaces stale connections and fails their requests", () =>
  Effect.gen(function* () {
    const broker = makePreviewAutomationBroker();
    const threadId = ThreadId.makeUnsafe("thread-preview");
    let captured: PreviewAutomationRequest | null = null;
    const client = {
      clientId: "server-client-1",
      rendererClientId: "renderer-1",
      send: (request: PreviewAutomationRequest) =>
        Effect.sync(() => {
          captured = request;
          return true;
        }),
    };
    const owner = {
      clientId: "renderer-1",
      threadId,
      tabId: null,
      visible: true,
      supportsAutomation: true,
      focusedAt: "2026-06-23T10:00:00.000Z",
    } as const;

    const first = yield* broker.reportOwner(owner, client);
    const renewed = yield* broker.reportOwner(
      { ...owner, connectionId: first.connectionId },
      client,
    );
    assert.equal(renewed.connectionId, first.connectionId);

    const pending = Effect.runPromiseExit(
      broker.invoke({ threadId, operation: "status", input: {} }),
    );
    while (!captured) yield* Effect.sleep("1 millis");

    const replacement = yield* broker.reportOwner(owner, client);
    assert.notEqual(replacement.connectionId, first.connectionId);
    const result = yield* Effect.promise(() => pending);
    assert.equal(result._tag, "Failure");
    if (Exit.isFailure(result)) {
      const error = Exit.findErrorOption(result);
      assert.equal(Option.isSome(error) && error.value._tag, "PreviewAutomationUnavailableError");
    }
  }),
);

it.effect("lease expiry fails pending work and drops automation-session tab assignments", () =>
  Effect.gen(function* () {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const broker = makePreviewAutomationBroker();
    const threadId = ThreadId.makeUnsafe("thread-preview");
    let holdRequests = false;
    const seenTabs: Array<string | undefined> = [];
    const register = (clientId: string, activeTab: string) =>
      broker.reportOwner(
        {
          clientId,
          threadId,
          tabId: activeTab,
          visible: true,
          supportsAutomation: true,
          focusedAt: new Date(now).toISOString(),
        },
        {
          clientId,
          send: (request) =>
            Effect.sync(() => {
              seenTabs.push(request.tabId);
              if (!holdRequests) {
                void Effect.runPromise(
                  broker.respond(
                    {
                      requestId: request.requestId,
                      clientId: request.clientId,
                      connectionId: request.connectionId,
                      ok: true,
                      result:
                        request.operation === "open"
                          ? { tabId: "tab-session", available: true }
                          : { available: true },
                    },
                    new Set([clientId]),
                  ),
                );
              }
              return true;
            }),
        },
      );

    yield* register("client-1", "tab-old-active");
    yield* broker.invoke({
      threadId,
      automationSessionId: "session-a",
      operation: "open",
      input: {},
    });
    holdRequests = true;
    const pending = Effect.runPromiseExit(
      broker.invoke({ threadId, operation: "status", input: {} }),
    );
    while (seenTabs.length < 2) yield* Effect.sleep("1 millis");

    now += 31_000;
    const afterExpiry = yield* Effect.exit(
      broker.invoke({ threadId, operation: "status", input: {} }),
    );
    assert.equal(afterExpiry._tag, "Failure");
    const pendingResult = yield* Effect.promise(() => pending);
    assert.equal(pendingResult._tag, "Failure");

    holdRequests = false;
    yield* register("client-2", "tab-new-active");
    // The session was bound to the expired owner; it never silently moves.
    const rebound = yield* Effect.exit(
      broker.invoke({
        threadId,
        automationSessionId: "session-a",
        operation: "navigate",
        input: {},
      }),
    );
    assert.equal(rebound._tag, "Failure");
    yield* broker.invoke({
      threadId,
      automationSessionId: "session-a",
      operation: "open",
      input: {},
    });
    yield* broker.invoke({
      threadId,
      automationSessionId: "session-a",
      operation: "navigate",
      input: {},
    });
    assert.equal(seenTabs.at(-1), "tab-session");
  }),
);

it.effect("rejects automation before dispatch when project browser access is disabled", () =>
  Effect.gen(function* () {
    const broker = makePreviewAutomationBroker({
      resolvePolicy: () => Effect.succeed(DISABLED_AGENT_BROWSER_POLICY),
    });
    const result = yield* Effect.exit(
      broker.invoke({
        threadId: ThreadId.makeUnsafe("disabled-thread"),
        operation: "status",
        input: {},
      }),
    );
    assert.equal(result._tag, "Failure");
  }),
);

type Broker = ReturnType<typeof makePreviewAutomationBroker>;
type HostEvent = Parameters<Parameters<Broker["registerHost"]>[0]["push"]>[0];

function recordingHost(broker: Broker, hostId: string) {
  const events: HostEvent[] = [];
  return {
    events,
    register: broker.registerHost({
      hostId,
      push: (event) => Effect.sync(() => (events.push(event), true)),
    }),
  };
}

/** An owner that answers each request through `answer`, or holds it when that returns undefined. */
function reportAnsweringOwner(
  broker: Broker,
  input: {
    readonly clientId: string;
    readonly threadId: ThreadId;
    readonly hostId?: string;
    readonly visible?: boolean;
    readonly answer: (request: PreviewAutomationRequest) => unknown;
    readonly seen?: PreviewAutomationRequest[];
  },
) {
  return broker.reportOwner(
    {
      clientId: input.clientId,
      threadId: input.threadId,
      tabId: "tab-1" as never,
      visible: input.visible ?? true,
      supportsAutomation: true,
      capabilities: ["automation", "viewport", "screenshot"],
      focusedAt: new Date().toISOString(),
    },
    {
      clientId: input.clientId,
      ...(input.hostId ? { hostId: input.hostId } : {}),
      send: (request) =>
        Effect.sync(() => {
          input.seen?.push(request);
          const result = input.answer(request);
          if (result !== undefined) {
            void Effect.runPromise(
              broker.respond(
                {
                  requestId: request.requestId,
                  clientId: request.clientId,
                  connectionId: request.connectionId,
                  ok: true,
                  result,
                },
                new Set([input.clientId]),
              ),
            );
          }
          return true;
        }),
    },
  );
}

it.live("requests an owner from the most recently active desktop host and waits for it", () =>
  Effect.gen(function* () {
    const broker = makePreviewAutomationBroker();
    const threadId = ThreadId.makeUnsafe("thread-auto-open");
    const otherThread = ThreadId.makeUnsafe("thread-other");
    const older = recordingHost(broker, "host-old");
    const newer = recordingHost(broker, "host-new");
    yield* older.register;
    yield* newer.register;
    yield* reportAnsweringOwner(broker, {
      clientId: "old-owner",
      threadId: otherThread,
      hostId: "host-old",
      answer: () => ({}),
    });
    yield* Effect.sleep("5 millis");
    yield* reportAnsweringOwner(broker, {
      clientId: "new-owner",
      threadId: otherThread,
      hostId: "host-new",
      answer: () => ({}),
    });

    const opened = Effect.runPromiseExit(
      broker.invoke({ threadId, operation: "open", input: {}, timeoutMs: 5_000 }),
    );
    const second = Effect.runPromiseExit(
      broker.invoke({ threadId, operation: "open", input: {}, timeoutMs: 5_000 }),
    );
    while (newer.events.length === 0) yield* Effect.sleep("1 millis");
    // Concurrent opens share one request, sent only to the most recent host.
    assert.equal(newer.events.filter((event) => event.type === "ownerRequested").length, 1);
    assert.equal(older.events.length, 0);

    yield* reportAnsweringOwner(broker, {
      clientId: "auto-owner",
      threadId,
      hostId: "host-new",
      answer: (request) => ({ tabId: "tab-auto", operation: request.operation }),
    });
    const [first, next] = yield* Effect.promise(() => Promise.all([opened, second]));
    assert.equal(Exit.isSuccess(first), true);
    assert.equal(Exit.isSuccess(next), true);
  }),
);

it.live("broadcasts owner requests when no host has reported an owner", () =>
  Effect.gen(function* () {
    const broker = makePreviewAutomationBroker();
    const threadId = ThreadId.makeUnsafe("thread-broadcast");
    const first = recordingHost(broker, "host-a");
    const second = recordingHost(broker, "host-b");
    yield* first.register;
    yield* second.register;
    const opened = Effect.runPromiseExit(
      broker.invoke({ threadId, operation: "open", input: {}, timeoutMs: 50 }),
    );
    const result = yield* Effect.promise(() => opened);
    assert.equal(first.events[0]?.type, "ownerRequested");
    assert.equal(second.events[0]?.type, "ownerRequested");
    // Nobody answered within the request's own budget.
    assert.equal(result._tag, "Failure");
  }),
);

it.effect("status never waits for or requests an owner", () =>
  Effect.gen(function* () {
    const broker = makePreviewAutomationBroker();
    const host = recordingHost(broker, "host-a");
    yield* host.register;
    const result = yield* Effect.exit(
      broker.invoke({ threadId: ThreadId.makeUnsafe("t"), operation: "status", input: {} }),
    );
    assert.equal(result._tag, "Failure");
    assert.equal(host.events.length, 0);
  }),
);

it.live("a renderer can reject an owner request with capacity-exceeded", () =>
  Effect.gen(function* () {
    const broker = makePreviewAutomationBroker();
    const threadId = ThreadId.makeUnsafe("thread-full");
    const host = recordingHost(broker, "host-a");
    yield* host.register;
    const opened = Effect.runPromiseExit(
      broker.invoke({ threadId, operation: "open", input: {}, timeoutMs: 5_000 }),
    );
    while (host.events.length === 0) yield* Effect.sleep("1 millis");
    const request = host.events[0];
    assert.equal(request?.type, "ownerRequested");
    yield* broker.respond(
      {
        requestId: request?.type === "ownerRequested" ? request.requestId : "",
        ok: false,
        error: { _tag: "PreviewAutomationCapacityExceededError", message: "full" },
      },
      new Set(),
      "host-a",
    );
    const result = yield* Effect.promise(() => opened);
    assert.equal(
      Exit.isFailure(result) && JSON.stringify(result.cause).includes("CapacityExceeded"),
      true,
    );
  }),
);

it.effect("binds an automation session to its first owner", () =>
  Effect.gen(function* () {
    const broker = makePreviewAutomationBroker();
    const threadId = ThreadId.makeUnsafe("thread-bound");
    const firstSeen: PreviewAutomationRequest[] = [];
    const secondSeen: PreviewAutomationRequest[] = [];
    yield* reportAnsweringOwner(broker, {
      clientId: "window-1",
      threadId,
      visible: false,
      answer: () => ({}),
      seen: firstSeen,
    });
    yield* broker.invoke({ threadId, automationSessionId: "s", operation: "open", input: {} });
    // A second, visible window for the same thread does not take over.
    yield* reportAnsweringOwner(broker, {
      clientId: "window-2",
      threadId,
      visible: true,
      answer: () => ({}),
      seen: secondSeen,
    });
    yield* broker.invoke({ threadId, automationSessionId: "s", operation: "click", input: {} });
    assert.equal(firstSeen.length, 2);
    assert.equal(secondSeen.length, 0);
    // Unbound callers still prefer the visible owner.
    yield* broker.invoke({ threadId, operation: "status", input: {} });
    assert.equal(secondSeen.length, 1);
  }),
);

it.live("serializes mutating operations per thread and rejects overflow as busy", () =>
  Effect.gen(function* () {
    const broker = makePreviewAutomationBroker();
    const threadId = ThreadId.makeUnsafe("thread-queue");
    const seen: PreviewAutomationRequest[] = [];
    yield* reportAnsweringOwner(broker, {
      clientId: "owner",
      threadId,
      answer: () => undefined,
      seen,
    });
    const running = Array.from({ length: 1 + MAX_QUEUED_MUTATIONS_PER_THREAD }, () =>
      Effect.runPromiseExit(
        broker.invoke({ threadId, operation: "click", input: {}, timeoutMs: 5_000 }),
      ),
    );
    while (seen.length === 0) yield* Effect.sleep("1 millis");
    yield* Effect.sleep("5 millis");
    // Only the first click reached the host; the rest wait in FIFO order.
    assert.equal(seen.length, 1);
    const overflow = yield* Effect.exit(
      broker.invoke({ threadId, operation: "click", input: {}, timeoutMs: 5_000 }),
    );
    assert.equal(JSON.stringify(overflow).includes("PreviewAutomationBusyError"), true);
    // Observing is never queued behind mutations.
    const status = Effect.runPromiseExit(
      broker.invoke({ threadId, operation: "status", input: {} }),
    );
    while (seen.length < 2) yield* Effect.sleep("1 millis");
    assert.equal(seen[1]?.operation, "status");

    // Pausing fails everything queued; the in-flight request is the renderer's to cancel.
    yield* broker.setPaused(threadId, true);
    const queued = yield* Effect.promise(() => Promise.all(running.slice(1)));
    assert.equal(
      queued.every(
        (exit) => Exit.isFailure(exit) && JSON.stringify(exit.cause).includes("ControlInterrupted"),
      ),
      true,
    );
    void status;
  }),
);

it.live("pause blocks open and mutations but allows observation", () =>
  Effect.gen(function* () {
    const broker = makePreviewAutomationBroker();
    const threadId = ThreadId.makeUnsafe("thread-paused");
    const host = recordingHost(broker, "host-a");
    yield* host.register;
    yield* reportAnsweringOwner(broker, {
      clientId: "owner",
      threadId,
      answer: () => ({ available: true }),
    });
    yield* broker.setPaused(threadId, true);
    assert.deepEqual(host.events, [{ type: "pauseChanged", threadId, paused: true }]);
    for (const operation of ["open", "click", "type", "navigate", "evaluate"] as const) {
      const result = yield* Effect.exit(broker.invoke({ threadId, operation, input: {} }));
      assert.equal(
        JSON.stringify(result).includes("PreviewAutomationControlInterruptedError"),
        true,
      );
    }
    const status = yield* broker.invoke({ threadId, operation: "status", input: {} });
    assert.deepEqual(status, { available: true, paused: true, reason: "paused" });
    yield* broker.invoke({ threadId, operation: "snapshot", input: {} });
    yield* broker.invoke({ threadId, operation: "screenshot", input: {} });
    yield* broker.setPaused(threadId, false);
    yield* broker.invoke({ threadId, operation: "click", input: {} });
  }),
);

it.effect("releaseThread drops bindings and tells hosts to unpin", () =>
  Effect.gen(function* () {
    const broker = makePreviewAutomationBroker();
    const threadId = ThreadId.makeUnsafe("thread-release");
    const host = recordingHost(broker, "host-a");
    yield* host.register;
    yield* reportAnsweringOwner(broker, { clientId: "owner", threadId, answer: () => ({}) });
    yield* broker.invoke({ threadId, automationSessionId: "s", operation: "open", input: {} });
    yield* broker.releaseThread(threadId);
    assert.deepEqual(host.events.at(-1), { type: "ownerReleased", threadId });
  }),
);

it.live("shutdown rejects owner waiters", () =>
  Effect.gen(function* () {
    const broker = makePreviewAutomationBroker();
    const host = recordingHost(broker, "host-a");
    yield* host.register;
    const opened = Effect.runPromiseExit(
      broker.invoke({
        threadId: ThreadId.makeUnsafe("thread-shutdown"),
        operation: "open",
        input: {},
        timeoutMs: 5_000,
      }),
    );
    while (host.events.length === 0) yield* Effect.sleep("1 millis");
    yield* broker.shutdown;
    const result = yield* Effect.promise(() => opened);
    assert.equal(result._tag, "Failure");
  }),
);

it.live("expires a queued mutation at its deadline without dispatching it", () =>
  Effect.gen(function* () {
    const broker = makePreviewAutomationBroker();
    const threadId = ThreadId.makeUnsafe("thread-expiry");
    const seen: PreviewAutomationRequest[] = [];
    yield* reportAnsweringOwner(broker, {
      clientId: "owner",
      threadId,
      answer: () => undefined,
      seen,
    });
    void Effect.runPromiseExit(
      broker.invoke({ threadId, operation: "click", input: {}, timeoutMs: 5_000 }),
    );
    while (seen.length === 0) yield* Effect.sleep("1 millis");
    const queued = yield* Effect.exit(
      broker.invoke({ threadId, operation: "click", input: {}, timeoutMs: 30 }),
    );
    assert.equal(Exit.isFailure(queued) && JSON.stringify(queued.cause).includes("not run"), true);
    yield* Effect.sleep("20 millis");
    assert.equal(seen.length, 1);
  }),
);

it.live("re-checks live policy before running a mutation that waited its turn", () =>
  Effect.gen(function* () {
    let enabled = true;
    const broker = makePreviewAutomationBroker({
      resolvePolicy: () =>
        Effect.succeed({ ...DISABLED_AGENT_BROWSER_POLICY, previewAutomation: enabled }),
    });
    const threadId = ThreadId.makeUnsafe("thread-queue-revoked");
    const seen: PreviewAutomationRequest[] = [];
    yield* reportAnsweringOwner(broker, {
      clientId: "owner",
      threadId,
      answer: () => undefined,
      seen,
    });
    const first = Effect.runPromiseExit(
      broker.invoke({ threadId, operation: "click", input: {}, timeoutMs: 5_000 }),
    );
    while (seen.length === 0) yield* Effect.sleep("1 millis");
    const second = Effect.runPromiseExit(
      broker.invoke({ threadId, operation: "click", input: {}, timeoutMs: 5_000 }),
    );
    yield* Effect.sleep("5 millis");
    enabled = false;
    const request = seen[0]!;
    yield* broker.respond(
      {
        requestId: request.requestId,
        clientId: request.clientId,
        connectionId: request.connectionId,
        ok: true,
        result: {},
      },
      new Set(["owner"]),
    );
    assert.equal(Exit.isSuccess(yield* Effect.promise(() => first)), true);
    const result = yield* Effect.promise(() => second);
    assert.equal(Exit.isFailure(result) && JSON.stringify(result.cause).includes("disabled"), true);
    assert.equal(seen.length, 1);
  }),
);

it.live("re-checks live policy after waiting for an owner", () =>
  Effect.gen(function* () {
    let enabled = true;
    const broker = makePreviewAutomationBroker({
      resolvePolicy: () =>
        Effect.succeed({ ...DISABLED_AGENT_BROWSER_POLICY, previewAutomation: enabled }),
    });
    const threadId = ThreadId.makeUnsafe("thread-revoked");
    const host = recordingHost(broker, "host-a");
    yield* host.register;
    const opened = Effect.runPromiseExit(
      broker.invoke({ threadId, operation: "open", input: {}, timeoutMs: 5_000 }),
    );
    while (host.events.length === 0) yield* Effect.sleep("1 millis");
    enabled = false;
    yield* reportAnsweringOwner(broker, { clientId: "owner", threadId, answer: () => ({}) });
    const result = yield* Effect.promise(() => opened);
    assert.equal(Exit.isFailure(result) && JSON.stringify(result.cause).includes("disabled"), true);
  }),
);
