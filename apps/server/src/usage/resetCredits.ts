import {
  UsageConsumeResetCreditResult,
  type UsageConsumeResetCreditInput,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { UsageQueryError } from "./Services/UsageService.ts";

/** Ambiguous attempts remain pending: only the original key can retry them. */
export const makeResetCreditCoordinator = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const active = new Set<string>();
  return <E>(
    input: UsageConsumeResetCreditInput,
    redeem: (key: string) => Effect.Effect<unknown, E>,
    identity: string = input.providerInstanceId,
  ) =>
    Effect.gen(function* () {
      if (active.has(identity))
        return yield* Effect.fail(
          new UsageQueryError({
            message: "A reset-credit redemption is already running for this account.",
          }),
        );
      active.add(identity);
      return yield* Effect.gen(function* () {
        if (identity !== input.providerInstanceId) {
          yield* sql`UPDATE usage_reset_credit_requests SET provider_instance_id = ${identity} WHERE provider_instance_id = ${input.providerInstanceId}`;
        }
        const rows = yield* sql<{
          idempotencyKey: string;
          resultJson: string | null;
        }>`SELECT idempotency_key AS "idempotencyKey", result_json AS "resultJson" FROM usage_reset_credit_requests WHERE provider_instance_id = ${identity} AND (idempotency_key = ${input.idempotencyKey} OR result_json IS NULL)`;
        const prior = rows.find((row) => row.idempotencyKey === input.idempotencyKey);
        if (prior?.resultJson)
          return yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(UsageConsumeResetCreditResult),
          )(prior.resultJson);
        // Recover an uncertain attempt even when the original client lost its key.
        // Never dispatch a new key while an older one could have spent a credit.
        const key =
          rows.find((row) => row.resultJson === null)?.idempotencyKey ?? input.idempotencyKey;
        yield* sql`INSERT INTO usage_reset_credit_requests (provider_instance_id, idempotency_key) VALUES (${identity}, ${key}) ON CONFLICT DO NOTHING`;
        const result = yield* redeem(key).pipe(
          Effect.timeout("30 seconds"),
          Effect.flatMap(Schema.decodeUnknownEffect(UsageConsumeResetCreditResult)),
        );
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE usage_reset_credit_requests SET result_json = ${JSON.stringify(result)} WHERE provider_instance_id = ${identity} AND idempotency_key = ${key}`;
            if (key !== input.idempotencyKey)
              yield* sql`INSERT INTO usage_reset_credit_requests (provider_instance_id, idempotency_key, result_json) VALUES (${identity}, ${input.idempotencyKey}, ${JSON.stringify(result)}) ON CONFLICT DO NOTHING`;
          }),
        );
        return result;
      }).pipe(Effect.ensuring(Effect.sync(() => active.delete(identity))));
    }).pipe(
      Effect.mapError((error) =>
        Schema.is(UsageQueryError)(error)
          ? error
          : new UsageQueryError({
              message: "Reset-credit redemption could not be confirmed. Retry with the same key.",
            }),
      ),
    );
});
