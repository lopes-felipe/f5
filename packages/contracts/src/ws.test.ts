import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { ORCHESTRATION_WS_CHANNELS, ORCHESTRATION_WS_METHODS } from "./orchestration";
import { ServerValidateHarnessesResult } from "./server";
import { WebSocketRequest, WsResponse, WS_CHANNELS, WS_METHODS } from "./ws";

const decodeWebSocketRequest = Schema.decodeUnknownEffect(WebSocketRequest);
const decodeWsResponse = Schema.decodeUnknownEffect(WsResponse);
const decodeServerValidateHarnessesResult = Schema.decodeUnknownEffect(
  ServerValidateHarnessesResult,
);

it.effect("accepts getTurnDiff requests when fromTurnCount <= toTurnCount", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeWebSocketRequest({
      id: "req-1",
      body: {
        _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
        threadId: "thread-1",
        fromTurnCount: 1,
        toTurnCount: 2,
      },
    });
    assert.strictEqual(parsed.body._tag, ORCHESTRATION_WS_METHODS.getTurnDiff);
  }),
);

it.effect("rejects getTurnDiff requests when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeWebSocketRequest({
        id: "req-1",
        body: {
          _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
          threadId: "thread-1",
          fromTurnCount: 3,
          toTurnCount: 2,
        },
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("trims websocket request id and nested orchestration ids", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeWebSocketRequest({
      id: " req-1 ",
      body: {
        _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
        threadId: " thread-1 ",
        fromTurnCount: 0,
        toTurnCount: 0,
      },
    });
    assert.strictEqual(parsed.id, "req-1");
    assert.strictEqual(parsed.body._tag, ORCHESTRATION_WS_METHODS.getTurnDiff);
    if (parsed.body._tag === ORCHESTRATION_WS_METHODS.getTurnDiff) {
      assert.strictEqual(parsed.body.threadId, "thread-1");
    }
  }),
);

it.effect("accepts git.preparePullRequestThread requests", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeWebSocketRequest({
      id: "req-pr-1",
      body: {
        _tag: WS_METHODS.gitPreparePullRequestThread,
        cwd: "/repo",
        reference: "#42",
        mode: "worktree",
      },
    });
    assert.strictEqual(parsed.body._tag, WS_METHODS.gitPreparePullRequestThread);
  }),
);

it.effect("accepts server.validateHarnesses requests without provider options", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeWebSocketRequest({
      id: "req-harness-1",
      body: {
        _tag: WS_METHODS.serverValidateHarnesses,
      },
    });
    assert.strictEqual(parsed.body._tag, WS_METHODS.serverValidateHarnesses);
  }),
);

it.effect("accepts server.validateHarnesses results", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeServerValidateHarnessesResult({
      results: [
        {
          provider: "codex",
          status: "ready",
          installed: true,
          authStatus: "authenticated",
          checkedAt: "2026-04-23T12:00:00.000Z",
          version: "1.2.3",
        },
        {
          provider: "claudeAgent",
          status: "error",
          installed: false,
          authStatus: "unknown",
          failureKind: "notInstalled",
          checkedAt: "2026-04-23T12:00:00.000Z",
          message: "Claude Code is not installed.",
        },
      ],
    });

    assert.strictEqual(parsed.results.length, 2);
    assert.strictEqual(parsed.results[0]?.provider, "codex");
    assert.strictEqual(parsed.results[1]?.failureKind, "notInstalled");
  }),
);

it.effect("accepts typed websocket push envelopes with sequence", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeWsResponse({
      type: "push",
      sequence: 1,
      channel: WS_CHANNELS.serverWelcome,
      data: {
        cwd: "/tmp/workspace",
        projectName: "workspace",
      },
    });

    if (!("type" in parsed) || parsed.type !== "push") {
      assert.fail("expected websocket response to decode as a push envelope");
    }

    assert.strictEqual(parsed.type, "push");
    assert.strictEqual(parsed.sequence, 1);
    assert.strictEqual(parsed.channel, WS_CHANNELS.serverWelcome);
  }),
);

it.effect("rejects push envelopes when channel payload does not match the channel schema", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeWsResponse({
        type: "push",
        sequence: 2,
        channel: ORCHESTRATION_WS_CHANNELS.domainEvent,
        data: {
          cwd: "/tmp/workspace",
          projectName: "workspace",
        },
      }),
    );

    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("accepts git status invalidation push envelopes", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeWsResponse({
      type: "push",
      sequence: 3,
      channel: WS_CHANNELS.gitStatusInvalidated,
      data: {
        cwd: "/tmp/worktree",
      },
    });

    if (!("type" in parsed) || parsed.type !== "push") {
      assert.fail("expected websocket response to decode as a push envelope");
    }

    assert.strictEqual(parsed.channel, WS_CHANNELS.gitStatusInvalidated);
    assert.deepStrictEqual(parsed.data, { cwd: "/tmp/worktree" });
  }),
);

it.effect("accepts global git status invalidation push envelopes", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeWsResponse({
      type: "push",
      sequence: 4,
      channel: WS_CHANNELS.gitStatusInvalidated,
      data: {
        cwd: null,
      },
    });

    if (!("type" in parsed) || parsed.type !== "push") {
      assert.fail("expected websocket response to decode as a push envelope");
    }

    assert.strictEqual(parsed.channel, WS_CHANNELS.gitStatusInvalidated);
    assert.deepStrictEqual(parsed.data, { cwd: null });
  }),
);
