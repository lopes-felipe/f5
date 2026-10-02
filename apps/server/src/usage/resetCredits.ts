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
  return <E>(input: UsageConsumeResetCreditInput, redeem: () => Effect.Effect<unknown, E>) =>
    Effect.gen(function* () {
      if (active.has(input.providerInstanceId))
        return yield* Effect.fail(
          new UsageQueryError({
            message: "A reset-credit redemption is already running for this account.",
          }),
        );
      active.add(input.providerInstanceId);
      return yield* Effect.gen(function* () {
        const rows = yield* sql<{
          idempotencyKey: string;
          resultJson: string | null;
        }>`SELECT idempotency_key AS "idempotencyKey", result_json AS "resultJson" FROM usage_reset_credit_requests WHERE provider_instance_id = ${input.providerInstanceId} AND (idempotency_key = ${input.idempotencyKey} OR result_json IS NULL)`;
        const prior = rows.find((row) => row.idempotencyKey === input.idempotencyKey);
        if (prior?.resultJson)
          return Schema.decodeUnknownSync(Schema.fromJsonString(UsageConsumeResetCreditResult))(
            prior.resultJson,
          );
        if (rows.some((row) => row.idempotencyKey !== input.idempotencyKey))
          return yield* Effect.fail(
            new UsageQueryError({
              message: "The previous redemption outcome is uncertain. Retry with its original key.",
            }),
          );
        yield* sql`INSERT INTO usage_reset_credit_requests (provider_instance_id, idempotency_key) VALUES (${input.providerInstanceId}, ${input.idempotencyKey}) ON CONFLICT DO NOTHING`;
        const result = yield* redeem().pipe(
          Effect.timeout("30 seconds"),
          Effect.flatMap(Schema.decodeUnknownEffect(UsageConsumeResetCreditResult)),
        );
        yield* sql`UPDATE usage_reset_credit_requests SET result_json = ${JSON.stringify(result)} WHERE provider_instance_id = ${input.providerInstanceId} AND idempotency_key = ${input.idempotencyKey}`;
        return result;
      }).pipe(Effect.ensuring(Effect.sync(() => active.delete(input.providerInstanceId))));
    }).pipe(
      Effect.mapError(
        () =>
          new UsageQueryError({
            message: "Reset-credit redemption could not be confirmed. Retry with the same key.",
          }),
      ),
    );
});
