import { it, assert } from "@effect/vitest";
import { Effect, Deferred, Fiber } from "effect";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
import Migration from "../persistence/Migrations/101_UsageResetCreditRequests.ts";
import GrantMigration from "../persistence/Migrations/165_UsageResetCreditGrant.ts";
import {
  makeResetCreditCoordinator,
  RESET_CREDIT_OTHER_GRANT_PENDING_MESSAGE,
} from "./resetCredits.ts";

it.layer(SqliteClient.layerMemory())("reset credits", (it) => {
  it.effect(
    "serializes per instance, remembers successful keys, and preserves ambiguity across restart",
    () =>
      Effect.gen(function* () {
        yield* Migration;
        yield* GrantMigration;
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
        let recoveredKey = "";
        assert.deepEqual(
          yield* secondRestart(
            {
              ...input,
              providerInstanceId: ProviderInstanceId.make("another"),
              idempotencyKey: "new",
            },
            (key) => {
              recoveredKey = key;
              return Effect.succeed({ outcome: "alreadyRedeemed" });
            },
            input.providerInstanceId,
          ),
          { outcome: "alreadyRedeemed" },
        );
        assert.equal(recoveredKey, "ambiguous");
        assert.deepEqual(
          yield* secondRestart(ambiguousInput, () =>
            Effect.succeed({ outcome: "alreadyRedeemed" }),
          ),
          { outcome: "alreadyRedeemed" },
        );
      }),
  );
});

it.layer(SqliteClient.layerMemory())("reset credits across grants", (it) => {
  it.effect("replays an unconfirmed claim only for its own grant", () =>
    Effect.gen(function* () {
      yield* Migration;
      yield* GrantMigration;
      const redeem = yield* makeResetCreditCoordinator;
      const claude = ProviderInstanceId.make("claude");
      const sent: Array<[string, string | undefined]> = [];
      const record = (key: string, grantId: string | undefined) =>
        Effect.sync(() => {
          sent.push([key, grantId]);
          return { outcome: "reset" as const };
        });
      // An ambiguous claim on grant A leaves K1 pending.
      const ambiguous = yield* Effect.exit(
        redeem({ providerInstanceId: claude, idempotencyKey: "k1", grantId: "full" }, () =>
          Effect.fail("timeout"),
        ),
      );
      assert.equal(ambiguous._tag, "Failure");
      // A claim on grant B is refused instead of sending K1 with grant B.
      const other = yield* Effect.exit(
        redeem({ providerInstanceId: claude, idempotencyKey: "k2", grantId: "fable" }, record),
      );
      assert.equal(other._tag, "Failure");
      assert.include(
        other._tag === "Failure" ? JSON.stringify(other.cause) : "",
        RESET_CREDIT_OTHER_GRANT_PENDING_MESSAGE,
      );
      assert.deepEqual(sent, []);
      // Retrying grant A, even with a lost key, replays K1 for grant A.
      assert.deepEqual(
        yield* redeem(
          { providerInstanceId: claude, idempotencyKey: "k3", grantId: "full" },
          record,
        ),
        { outcome: "reset" },
      );
      assert.deepEqual(sent, [["k1", "full"]]);
      // Once settled, grant B gets its own key.
      yield* redeem({ providerInstanceId: claude, idempotencyKey: "k2", grantId: "fable" }, record);
      assert.deepEqual(sent.at(-1), ["k2", "fable"]);
    }),
  );
});
