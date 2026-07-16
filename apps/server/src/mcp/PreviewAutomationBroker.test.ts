import { assert, it } from "@effect/vitest";
import { ThreadId, type PreviewAutomationRequest } from "@t3tools/contracts";
import { Effect, Exit, Option } from "effect";
import { afterEach, vi } from "vitest";

import { makePreviewAutomationBroker } from "./PreviewAutomationBroker.ts";

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
    yield* broker.invoke({
      threadId,
      automationSessionId: "session-a",
      operation: "navigate",
      input: {},
    });
    assert.equal(seenTabs.at(-1), "tab-new-active");
  }),
);
