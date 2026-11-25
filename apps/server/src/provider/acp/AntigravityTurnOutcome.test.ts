import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  parseAntigravityQuotaNotice,
  watchAntigravityPromptOutcome,
} from "./AntigravityTurnOutcome.ts";

const USER_INPUT = 14;
const PLANNER_RESPONSE = 15;
const TOOL = 8;
const ERROR_MESSAGE = 17;

// Error-step payloads trimmed from Antigravity 1.4.5 against a local Gemini endpoint.
const errorPayload = (error: string) =>
  Buffer.concat([
    Buffer.from([0x0a, 0x24]),
    Buffer.from(
      `Agent execution terminated due to error.\u0012agent executor error: ${error}: ${error}\n(1) attached stack trace\n  -- stack trace:`,
    ),
  ]);
// An unparsable reset timestamp must not hide the reset delay.
const QUOTA_ERROR = errorPayload(
  "Error 429, Message: Quota exhausted for test model., Status: RESOURCE_EXHAUSTED, Details: [map[@type:type.googleapis.com/google.rpc.ErrorInfo domain:googleapis.com metadata:map[quotaResetDelay:3600s quotaResetTimeStamp:soon] reason:QUOTA_EXHAUSTED]]",
);
const INVALID_ARGUMENT_ERROR = errorPayload(
  "Error 400, Message: Request contains an invalid argument., Status: INVALID_ARGUMENT, Details: []",
);
// The model's reply quoting the agent's quota notice is an ordinary planner response.
const QUOTED_NOTICE = Buffer.from(
  "Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 1 hour.",
);

describe("watchAntigravityPromptOutcome", () => {
  it.effect("fails only turns whose own steps end in an upstream error", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profileDirectory = yield* fs.makeTempDirectoryScoped();
      const sessionId = "e6aba774-5472-4277-b6ee-27b2e05570a7";
      const conversations = path.join(profileDirectory, "antigravity-acp", "conversations");
      yield* fs.makeDirectory(conversations, { recursive: true });
      let nextIndex = 0;
      const appendSteps = (steps: ReadonlyArray<readonly [number, Uint8Array]>) => {
        const database = new NodeSqlite.DatabaseSync(path.join(conversations, `${sessionId}.db`));
        try {
          database.exec(
            "CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)",
          );
          const insert = database.prepare("INSERT INTO steps VALUES (?, ?, ?)");
          for (const [type, payload] of steps) insert.run(nextIndex++, type, payload);
        } finally {
          database.close();
        }
      };
      const turn = (
        steps: ReadonlyArray<readonly [number, Uint8Array]>,
        result: EffectAcpSchema.PromptResponse = { stopReason: "end_turn" },
        options: { readonly unrecognizedErrors?: boolean } = {},
      ) =>
        Effect.gen(function* () {
          const check = yield* watchAntigravityPromptOutcome(profileDirectory, sessionId, options);
          appendSteps(steps);
          return yield* check(result);
        });
      const input = Buffer.from("Run the fixture.");
      const reply = Buffer.from("FIXTURE_OK");

      // The first prompt creates the session log.
      assert.isUndefined(
        yield* turn([
          [USER_INPUT, input],
          [PLANNER_RESPONSE, reply],
        ]),
      );
      assert.deepEqual(
        yield* turn([
          [USER_INPUT, input],
          [ERROR_MESSAGE, QUOTA_ERROR],
        ]),
        {
          class: "usage_limit",
          message: "You have reached your Antigravity quota for this period.",
          code: "RESOURCE_EXHAUSTED",
          retryable: true,
          resetAt: "1970-01-01T01:00:00.000Z",
        },
      );
      // The earlier error step is outside this turn.
      assert.isUndefined(
        yield* turn(
          [
            [USER_INPUT, input],
            [PLANNER_RESPONSE, QUOTED_NOTICE],
          ],
          {
            stopReason: "end_turn",
            usage: { inputTokens: 42, outputTokens: 3, totalTokens: 54 },
          },
        ),
      );
      assert.deepEqual(
        yield* turn([
          [USER_INPUT, input],
          [ERROR_MESSAGE, INVALID_ARGUMENT_ERROR],
        ]),
        {
          class: "provider_error",
          message: "Request contains an invalid argument.",
          code: "INVALID_ARGUMENT",
          retryable: false,
        },
      );
      // A completed tool keeps its usage, and the turn still fails.
      assert.equal(
        (yield* turn(
          [
            [USER_INPUT, input],
            [PLANNER_RESPONSE, reply],
            [TOOL, reply],
            [ERROR_MESSAGE, QUOTA_ERROR],
          ],
          {
            stopReason: "end_turn",
            usage: { inputTokens: 40, outputTokens: 5, totalTokens: 45 },
          },
        ))?.class,
        "usage_limit",
      );
      assert.isUndefined(
        yield* turn([
          [USER_INPUT, input],
          [PLANNER_RESPONSE, reply],
        ]),
      );
      // An error-typed step whose text is no recognised error: on a runtime whose step numbering
      // wasn't checked the type alone could mean something else, so the turn stands.
      const unrecognized = Buffer.from("something the harness has never written before");
      assert.isUndefined(
        yield* turn([
          [USER_INPUT, input],
          [ERROR_MESSAGE, unrecognized],
        ]),
      );
      assert.deepEqual(
        yield* turn(
          [
            [USER_INPUT, input],
            [ERROR_MESSAGE, unrecognized],
          ],
          { stopReason: "end_turn" },
          { unrecognizedErrors: true },
        ),
        {
          class: "provider_error",
          message: "Antigravity stopped this turn because of an error.",
        },
      );
      // Recognised API errors fail the turn either way.
      assert.equal(
        (yield* turn([
          [USER_INPUT, input],
          [ERROR_MESSAGE, INVALID_ARGUMENT_ERROR],
        ]))?.code,
        "INVALID_ARGUMENT",
      );
      // The agent maps the SDK's QUOTA_EXHAUSTED stop reason to `refusal`.
      assert.deepEqual(yield* turn([], { stopReason: "refusal" }), {
        class: "usage_limit",
        message: "You have reached your Antigravity quota for this period.",
        code: "QUOTA_EXHAUSTED",
        retryable: true,
      });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reads only this session's own unlinked log, and keeps a typed refusal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profileDirectory = yield* fs.makeTempDirectoryScoped();
      const conversations = path.join(profileDirectory, "antigravity-acp", "conversations");
      yield* fs.makeDirectory(conversations, { recursive: true });
      const own = "e6aba774-5472-4277-b6ee-27b2e05570a7";
      const peer = "0d9c2b4e-1111-4222-8333-944455556666";
      const append = (sessionId: string, type: number, payload: Uint8Array) => {
        const database = new NodeSqlite.DatabaseSync(path.join(conversations, `${sessionId}.db`));
        try {
          database.exec(
            "CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)",
          );
          database
            .prepare("INSERT INTO steps (step_type, step_payload) VALUES (?, ?)")
            .run(type, payload);
        } finally {
          database.close();
        }
      };

      // own.db links to a peer session; the peer's new error step is not this turn's.
      append(peer, USER_INPUT, Buffer.from("peer"));
      yield* fs.symlink(
        path.join(conversations, `${peer}.db`),
        path.join(conversations, `${own}.db`),
      );
      const linked = yield* watchAntigravityPromptOutcome(profileDirectory, own);
      append(peer, ERROR_MESSAGE, QUOTA_ERROR);
      assert.isUndefined(yield* linked({ stopReason: "end_turn" }));
      assert.equal((yield* linked({ stopReason: "refusal" }))?.class, "usage_limit");

      // An unreadable log gives no evidence, but the agent's typed refusal still fails the turn.
      yield* fs.remove(path.join(conversations, `${own}.db`));
      yield* fs.writeFileString(path.join(conversations, `${own}.db`), "not a database");
      const corrupt = yield* watchAntigravityPromptOutcome(profileDirectory, own);
      assert.isUndefined(yield* corrupt({ stopReason: "end_turn" }));
      assert.deepEqual(yield* corrupt({ stopReason: "refusal" }), {
        class: "usage_limit",
        message: "You have reached your Antigravity quota for this period.",
        code: "QUOTA_EXHAUSTED",
        retryable: true,
      });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

// Newer harnesses write the error step as protobuf fields: the UI message, then
// `STATUS (code N): message`, then the raw HTTP response with the JSON error body.
// Trimmed from a real Antigravity session log (2026-11-25).
const varint = (value: number) => {
  const bytes: number[] = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Buffer.from(bytes);
};
const field = (tag: number, text: string) => {
  const bytes = Buffer.from(text);
  return Buffer.concat([Buffer.from([tag]), varint(bytes.length), bytes]);
};
const statusFirstPayload = (input: {
  readonly status: string;
  readonly code: number;
  readonly message: string;
  readonly json: string;
  /** Field 4 (`"` tag), a printable byte, straight after the status field. */
  readonly trailingField?: string;
}) =>
  Buffer.concat([
    field(0x0a, input.message),
    field(0x12, `${input.status} (code ${input.code}): ${input.message}`),
    ...(input.trailingField === undefined ? [] : [field(0x22, input.trailingField)]),
    field(
      0x1a,
      `HTTP ${input.code} Too Many Requests\nSherlog: \nTraceID: 0x563a7d94f861a02c\n\n${input.json}`,
    ),
  ]);
const INDIVIDUAL_QUOTA =
  "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h6m56s.";
const quotaJson = (resetTimestamp: string) => `{
  "error": {
    "code": 429,
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "domain": "cloudcode-pa.googleapis.com",
        "metadata": {
          "model": "gemini-4-neon-high",
          "quotaResetDelay": "1h6m56.135688197s",
          "quotaResetTimeStamp": "${resetTimestamp}",
          "uiMessage": "true"
        },
        "reason": "QUOTA_EXHAUSTED"
      }
    ],
    "message": "${INDIVIDUAL_QUOTA}",
    "status": "RESOURCE_EXHAUSTED"
}`;
const JSON_QUOTA_ERROR = statusFirstPayload({
  status: "RESOURCE_EXHAUSTED",
  code: 429,
  message: INDIVIDUAL_QUOTA,
  json: quotaJson("2026-11-25T02:25:24Z"),
});
const NOTICE_TEXT =
  "\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h8m59s.\n";
const NOTICE_AT = "2026-11-25T01:16:24.775Z";

const makeSessionLog = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const profileDirectory = yield* fs.makeTempDirectoryScoped();
  const sessionId = "04a57a59-2df0-48ae-951b-f4a7d06c3bdc";
  const conversations = path.join(profileDirectory, "antigravity-acp", "conversations");
  yield* fs.makeDirectory(conversations, { recursive: true });
  const append = (steps: ReadonlyArray<readonly [number, Uint8Array]>) => {
    const database = new NodeSqlite.DatabaseSync(path.join(conversations, `${sessionId}.db`));
    try {
      database.exec(
        "CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)",
      );
      const insert = database.prepare("INSERT INTO steps (step_type, step_payload) VALUES (?, ?)");
      for (const [type, payload] of steps) insert.run(type, payload);
    } finally {
      database.close();
    }
  };
  append([
    [USER_INPUT, Buffer.from("Run the fixture.")],
    [PLANNER_RESPONSE, Buffer.from("FIXTURE_OK")],
  ]);
  return {
    append,
    watch: (options: { readonly unrecognizedErrors?: boolean } = {}) =>
      watchAntigravityPromptOutcome(profileDirectory, sessionId, options),
  };
});

describe("Antigravity status-first error steps", () => {
  it.effect("reads the JSON quota body and its reset", () =>
    Effect.gen(function* () {
      const log = yield* makeSessionLog;
      let check = yield* log.watch();
      log.append([
        [USER_INPUT, Buffer.from("go")],
        [ERROR_MESSAGE, JSON_QUOTA_ERROR],
      ]);
      assert.deepEqual(yield* check({ stopReason: "end_turn" }), {
        class: "usage_limit",
        message: "You have reached your Antigravity quota for this period.",
        code: "RESOURCE_EXHAUSTED",
        retryable: true,
        resetAt: "2026-11-25T02:25:24Z",
      });

      // An unparsable timestamp falls back to the quoted delay (TestClock starts at the epoch).
      check = yield* log.watch();
      log.append([
        [USER_INPUT, Buffer.from("go")],
        [
          ERROR_MESSAGE,
          statusFirstPayload({
            status: "RESOURCE_EXHAUSTED",
            code: 429,
            message: INDIVIDUAL_QUOTA,
            json: quotaJson("soon"),
          }),
        ],
      ]);
      assert.equal(
        (yield* check({ stopReason: "end_turn" }))?.resetAt,
        new Date(4_016_135.688197).toISOString(),
      );

      // A status-first error that is not a quota keeps its own message.
      check = yield* log.watch();
      log.append([
        [USER_INPUT, Buffer.from("go")],
        [
          ERROR_MESSAGE,
          statusFirstPayload({
            status: "INVALID_ARGUMENT",
            code: 400,
            message: "Request contains an invalid argument.",
            json: '{ "error": { "code": 400, "status": "INVALID_ARGUMENT" } }',
          }),
        ],
      ]);
      assert.deepEqual(yield* check({ stopReason: "end_turn" }), {
        class: "provider_error",
        message: "Request contains an invalid argument.",
        code: "INVALID_ARGUMENT",
        retryable: false,
      });

      // A one-byte field length can be a capital letter, and the next field's tag (`"`) and
      // length (`A`) are printable: the field's own length bounds the status and the message.
      const header = "NOT_FOUND (code 404): ";
      const shortMessage = "Requested model was not found".padEnd(0x46 - header.length, ".");
      check = yield* log.watch();
      log.append([
        [USER_INPUT, Buffer.from("go")],
        [
          ERROR_MESSAGE,
          statusFirstPayload({
            status: "NOT_FOUND",
            code: 404,
            message: shortMessage,
            json: '{ "error": { "code": 404 } }',
            trailingField: "A".repeat(0x41),
          }),
        ],
      ]);
      assert.deepEqual(yield* check({ stopReason: "end_turn" }), {
        class: "provider_error",
        message: shortMessage,
        code: "NOT_FOUND",
        retryable: false,
      });

      // A logged usage limit with no reset of its own takes the quota notice's.
      check = yield* log.watch();
      log.append([
        [USER_INPUT, Buffer.from("go")],
        [
          ERROR_MESSAGE,
          statusFirstPayload({
            status: "RESOURCE_EXHAUSTED",
            code: 429,
            message: "Too many requests.",
            json: '{ "error": { "code": 429, "status": "RESOURCE_EXHAUSTED" } }',
          }),
        ],
      ]);
      assert.deepEqual(
        yield* check({ stopReason: "end_turn" }, { text: NOTICE_TEXT, receivedAt: NOTICE_AT }),
        {
          class: "usage_limit",
          message: "Too many requests.",
          code: "RESOURCE_EXHAUSTED",
          retryable: true,
          resetAt: "2026-11-25T02:25:23.775Z",
          resetSource: "message",
        },
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("Antigravity quota notice", () => {
  it("parses only the harness notice shape", () => {
    assert.deepEqual(parseAntigravityQuotaNotice(NOTICE_TEXT, NOTICE_AT), {
      class: "usage_limit",
      message: "You have reached your Antigravity quota for this period.",
      code: "QUOTA_EXHAUSTED",
      retryable: true,
      resetAt: "2026-11-25T02:25:23.775Z",
      evidence: "message",
      resetSource: "message",
    });
    const at = Date.parse(NOTICE_AT);
    for (const [duration, ms] of [
      ["45m", 45 * 60_000],
      ["30s", 30_000],
      ["1h", 3_600_000],
    ] as const)
      assert.equal(
        parseAntigravityQuotaNotice(`⚠ Individual quota reached. Resets in ${duration}.`, NOTICE_AT)
          ?.resetAt,
        new Date(at + ms).toISOString(),
      );
    for (const text of [
      "⚠ Individual quota reached. Please upgrade your subscription.",
      "⚠ Individual quota reached. Resets in .",
      "⚠ Something else failed. Resets in 1h.",
      "Individual quota reached. Resets in 1h.",
      "Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 1 hour.",
    ])
      assert.isUndefined(parseAntigravityQuotaNotice(text, NOTICE_AT), text);
    assert.isUndefined(parseAntigravityQuotaNotice(NOTICE_TEXT, "not a date"));

    // The turn's accumulated text: the notice must be its own last line.
    assert.equal(
      parseAntigravityQuotaNotice(`Started on the change.${NOTICE_TEXT}`, NOTICE_AT)?.resetAt,
      "2026-11-25T02:25:23.775Z",
    );
    for (const text of [
      `Started on the change. ⚠ Individual quota reached. Resets in 1h.`,
      `${NOTICE_TEXT}Then the model kept going.`,
    ])
      assert.isUndefined(parseAntigravityQuotaNotice(text, NOTICE_AT), text);

    // Long non-matching text is rejected without scanning it.
    const hostile = `⚠ ${"quota ".repeat(200_000)}`;
    const started = performance.now();
    assert.isUndefined(parseAntigravityQuotaNotice(hostile, NOTICE_AT));
    assert.isBelow(performance.now() - started, 100);
  });

  it.live("waits for an error step the harness has not committed yet", () =>
    Effect.gen(function* () {
      const log = yield* makeSessionLog;
      const notice = { text: NOTICE_TEXT, receivedAt: NOTICE_AT };

      // The step lands while the check is waiting: the log's own reset wins.
      let check = yield* log.watch({ unrecognizedErrors: true });
      log.append([[USER_INPUT, Buffer.from("go")]]);
      const waiting = yield* check({ stopReason: "end_turn" }, notice).pipe(Effect.forkChild);
      yield* Effect.sleep("300 millis");
      log.append([[ERROR_MESSAGE, JSON_QUOTA_ERROR]]);
      const settled = yield* Fiber.join(waiting);
      assert.equal(settled?.resetAt, "2026-11-25T02:25:24Z");
      assert.isUndefined(settled?.evidence);

      // No step ever lands: the notice explains the turn.
      check = yield* log.watch({ unrecognizedErrors: true });
      log.append([[USER_INPUT, Buffer.from("go")]]);
      const started = Date.now();
      assert.deepEqual(yield* check({ stopReason: "end_turn" }, notice), {
        class: "usage_limit",
        message: "You have reached your Antigravity quota for this period.",
        code: "QUOTA_EXHAUSTED",
        retryable: true,
        resetAt: "2026-11-25T02:25:23.775Z",
        evidence: "message",
        resetSource: "message",
      });
      assert.isAtLeast(Date.now() - started, 1_900);

      // An unrecognised error step does not hide the quota notice, and since a committed step
      // will not change, there is no waiting for another.
      for (const unrecognizedErrors of [true, false]) {
        check = yield* log.watch({ unrecognizedErrors });
        log.append([
          [USER_INPUT, Buffer.from("go")],
          [ERROR_MESSAGE, Buffer.from("something the harness has never written before")],
        ]);
        const unrecognizedStarted = Date.now();
        assert.equal((yield* check({ stopReason: "end_turn" }, notice))?.evidence, "message");
        assert.isBelow(Date.now() - unrecognizedStarted, 1_000);
      }

      // A notice that is not a quota notice neither waits nor fails the turn.
      check = yield* log.watch();
      log.append([
        [USER_INPUT, Buffer.from("go")],
        [PLANNER_RESPONSE, Buffer.from("FIXTURE_OK")],
      ]);
      const quick = Date.now();
      assert.isUndefined(
        yield* check(
          { stopReason: "end_turn" },
          { text: "⚠ Tool output was truncated.", receivedAt: NOTICE_AT },
        ),
      );
      assert.isBelow(Date.now() - quick, 1_000);

      // A cancelled turn is not explained by a notice.
      check = yield* log.watch();
      log.append([[USER_INPUT, Buffer.from("go")]]);
      assert.isUndefined(yield* check({ stopReason: "cancelled" }, notice));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("uses the notice when the session log is not readable", () =>
    Effect.gen(function* () {
      // An invalid session id cannot name a log; the check falls back to typed evidence.
      const check = yield* watchAntigravityPromptOutcome("/nonexistent", "../escape");
      assert.equal(
        (yield* check({ stopReason: "end_turn" }, { text: NOTICE_TEXT, receivedAt: NOTICE_AT }))
          ?.evidence,
        "message",
      );
      assert.isUndefined(yield* check({ stopReason: "end_turn" }));
    }),
  );
});
