import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { Effect, Exit, Option } from "effect";

import { makePreviewAutomationBroker } from "./PreviewAutomationBroker.ts";

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
