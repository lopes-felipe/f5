import { CommandId, EventId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { makeProviderTurnIntentReceiptStore } from "./providerTurnIntentReceipts.ts";

const layer = it.layer(SqlitePersistenceMemory);

function intent(suffix: string) {
  return {
    commandId: CommandId.makeUnsafe(`receipt-command-${suffix}`),
    eventId: EventId.makeUnsafe(`receipt-event-${suffix}`),
    threadId: ThreadId.makeUnsafe(`receipt-thread-${suffix}`),
    attemptedAt: "2026-01-01T00:00:00.000Z",
  };
}

layer("ProviderTurnIntentReceiptStore", (it) => {
  it.effect("deduplicates delivery and persists provider acceptance", () =>
    Effect.gen(function* () {
      const firstProcess = yield* makeProviderTurnIntentReceiptStore("process-1");
      const input = intent("accepted");

      assert.deepEqual(yield* firstProcess.claim(input), { kind: "acquired" });
      assert.deepEqual(yield* firstProcess.claim(input), { kind: "in_progress" });
      yield* firstProcess.accept(input.commandId, "2026-01-01T00:00:01.000Z");

      const restartedProcess = yield* makeProviderTurnIntentReceiptStore("process-2");
      assert.deepEqual(yield* restartedProcess.claim(input), { kind: "accepted" });
      assert.equal((yield* restartedProcess.get(input.commandId))?.status, "accepted");
    }),
  );

  it.effect("marks an in-flight handoff unknown after a process restart", () =>
    Effect.gen(function* () {
      const firstProcess = yield* makeProviderTurnIntentReceiptStore("process-before-crash");
      const input = intent("unknown");
      yield* firstProcess.claim(input);

      const restartedProcess = yield* makeProviderTurnIntentReceiptStore("process-after-crash");
      const claim = yield* restartedProcess.claim(input);
      assert.equal(claim.kind, "delivery_unknown");
      assert.equal((yield* restartedProcess.get(input.commandId))?.status, "delivery_unknown");
    }),
  );

  it.effect("only retries a terminal handoff after explicit reset", () =>
    Effect.gen(function* () {
      const store = yield* makeProviderTurnIntentReceiptStore("process-retry");
      const input = intent("retry");
      yield* store.claim(input);
      yield* store.fail(input.commandId, "provider unavailable");

      assert.equal((yield* store.claim(input)).kind, "failed");
      assert.isTrue(yield* store.resetForExplicitRetry(input.commandId));
      assert.deepEqual(yield* store.claim(input), { kind: "acquired" });
    }),
  );
});
