import { it, assert } from "@effect/vitest";
import { Effect, Deferred, Fiber } from "effect";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
import Migration from "../persistence/Migrations/101_UsageResetCreditRequests.ts";
import { makeResetCreditCoordinator } from "./resetCredits.ts";

it.layer(SqliteClient.layerMemory())("reset credits", (it) => {
  it.effect(
    "serializes per instance, remembers successful keys, and preserves ambiguity across restart",
    () =>
      Effect.gen(function* () {
        yield* Migration;
        const redeem = yield* makeResetCreditCoordinator;
        const input = {
          providerInstanceId: ProviderInstanceId.make("codex"),
          idempotencyKey: "credit-1",
        };
        let calls = 0;
        const gate = yield* Deferred.make<void>();
        const attempt = yield* redeem(input, () =>
          Effect.gen(function* () {
            calls++;
            yield* Deferred.await(gate);
            return { outcome: "reset" };
          }),
        ).pipe(Effect.forkChild);
        for (let index = 0; index < 20; index++) yield* Effect.yieldNow;
        const competing = yield* Effect.exit(
          redeem({ ...input, idempotencyKey: "other" }, () => Effect.succeed({ outcome: "reset" })),
        );
        assert.equal(competing._tag, "Failure");
        yield* Deferred.succeed(gate, undefined);
        assert.deepEqual(yield* Fiber.join(attempt), { outcome: "reset" });
        const restarted = yield* makeResetCreditCoordinator;
        assert.deepEqual(
          yield* restarted(input, () =>
            Effect.sync(() => {
              calls++;
              return { outcome: "reset" };
            }),
          ),
          { outcome: "reset" },
        );
        assert.equal(calls, 1);
        const ambiguousInput = { ...input, idempotencyKey: "ambiguous" };
        assert.equal(
          (yield* Effect.exit(restarted(ambiguousInput, () => Effect.fail("connection lost"))))
            ._tag,
          "Failure",
        );
        const secondRestart = yield* makeResetCreditCoordinator;
        assert.equal(
          (yield* Effect.exit(
            secondRestart({ ...input, idempotencyKey: "new" }, () =>
              Effect.succeed({ outcome: "reset" }),
            ),
          ))._tag,
          "Failure",
        );
        assert.deepEqual(
          yield* secondRestart(ambiguousInput, () =>
            Effect.succeed({ outcome: "alreadyRedeemed" }),
          ),
          { outcome: "alreadyRedeemed" },
        );
      }),
  );
});
