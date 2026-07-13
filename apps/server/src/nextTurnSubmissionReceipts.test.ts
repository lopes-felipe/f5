import { CommandId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeNextTurnSubmissionReceiptStore } from "./nextTurnSubmissionReceipts.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";

const layer = it.layer(SqlitePersistenceMemory);

function submission(suffix: string) {
  return {
    itemId: CommandId.makeUnsafe(`submission-item-${suffix}`),
    commandId: CommandId.makeUnsafe(`submission-command-${suffix}`),
    threadId: ThreadId.makeUnsafe(`submission-thread-${suffix}`),
    requestHash: `hash-${suffix}`,
    now: "2026-01-01T00:00:00.000Z",
  };
}

layer("NextTurnSubmissionReceiptStore", (it) => {
  it.effect("returns a persisted started disposition without re-running delivery", () =>
    Effect.gen(function* () {
      const input = submission("started");
      const first = yield* makeNextTurnSubmissionReceiptStore("submission-process-1");

      assert.deepEqual(yield* first.claim(input), { kind: "acquired" });
      yield* first.beginStarting(input.itemId, "2026-01-01T00:00:01.000Z");
      yield* first.completeStarted(input.itemId, 42, "2026-01-01T00:00:02.000Z");

      const restarted = yield* makeNextTurnSubmissionReceiptStore("submission-process-2");
      assert.deepEqual(yield* restarted.claim(input), { kind: "started", sequence: 42 });

      yield* restarted.purgeThread(input.threadId);
      assert.deepEqual(yield* restarted.claim(input), { kind: "acquired" });
    }),
  );

  it.effect("marks an interrupted steer as delivery_unknown after restart", () =>
    Effect.gen(function* () {
      const input = submission("steer-unknown");
      const first = yield* makeNextTurnSubmissionReceiptStore("steer-process-1");
      yield* first.claim(input);
      yield* first.beginSteering(input.itemId, "2026-01-01T00:00:01.000Z");

      const restarted = yield* makeNextTurnSubmissionReceiptStore("steer-process-2");
      const claim = yield* restarted.claim(input);
      assert.equal(claim.kind, "delivery_unknown");
    }),
  );

  it.effect("reconciles an interrupted start instead of blindly resending it", () =>
    Effect.gen(function* () {
      const input = submission("start-recovery");
      const first = yield* makeNextTurnSubmissionReceiptStore("start-process-1");
      yield* first.claim(input);
      yield* first.beginStarting(input.itemId, "2026-01-01T00:00:01.000Z");

      const restarted = yield* makeNextTurnSubmissionReceiptStore("start-process-2");
      assert.deepEqual(yield* restarted.claim(input), { kind: "recover_starting" });
      yield* restarted.reclaimStarting(input.itemId, "2026-01-01T00:00:02.000Z");
      assert.deepEqual(yield* restarted.claim(input), { kind: "in_progress" });
    }),
  );

  it.effect("rejects reuse of an idempotency key for different content", () =>
    Effect.gen(function* () {
      const input = submission("conflict");
      const store = yield* makeNextTurnSubmissionReceiptStore("conflict-process");
      yield* store.claim(input);

      const conflict = yield* store.claim({ ...input, requestHash: "different-hash" });
      assert.equal(conflict.kind, "conflict");
    }),
  );
});
