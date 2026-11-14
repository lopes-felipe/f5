import {
  UsageConsumeResetCreditResult,
  type UsageConsumeResetCreditInput,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { UsageQueryError } from "./Services/UsageService.ts";

export const RESET_CREDIT_OTHER_GRANT_PENDING_MESSAGE =
  "An earlier limit-reset claim is still unconfirmed. Retry that reset first.";

/**
 * Ambiguous attempts remain pending: only the original key can retry them, and
 * always for the grant it was first sent with.
 */
export const makeResetCreditCoordinator = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const active = new Set<string>();
  return <E>(
    input: UsageConsumeResetCreditInput,
    redeem: (key: string, grantId: string | undefined) => Effect.Effect<unknown, E>,
    identity: string = input.providerInstanceId,
  ) =>
    Effect.gen(function* () {
      if (active.has(identity))
        return yield* new UsageQueryError({
          message: "A reset-credit redemption is already running for this account.",
        });
      active.add(identity);
      return yield* Effect.gen(function* () {
        if (identity !== input.providerInstanceId) {
          yield* sql`UPDATE usage_reset_credit_requests SET provider_instance_id = ${identity} WHERE provider_instance_id = ${input.providerInstanceId}`;
        }
        const rows = yield* sql<{
          idempotencyKey: string;
          resultJson: string | null;
          grantId: string | null;
        }>`SELECT idempotency_key AS "idempotencyKey", result_json AS "resultJson", grant_id AS "grantId" FROM usage_reset_credit_requests WHERE provider_instance_id = ${identity} AND (idempotency_key = ${input.idempotencyKey} OR result_json IS NULL)`;
        const prior = rows.find((row) => row.idempotencyKey === input.idempotencyKey);
        if (prior?.resultJson)
          return yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(UsageConsumeResetCreditResult),
          )(prior.resultJson);
        // Recover an uncertain attempt even when the original client lost its key.
        // Never dispatch a new key while an older one could have spent a credit.
        const pending = rows.find((row) => row.resultJson === null);
        const requestedGrant = input.grantId ?? null;
        // Replaying an unconfirmed claim for a different grant would spend a grant the
        // user did not pick now, and would report that outcome against this one.
        if (pending && (pending.grantId ?? null) !== requestedGrant)
          return yield* new UsageQueryError({ message: RESET_CREDIT_OTHER_GRANT_PENDING_MESSAGE });
        const key = pending?.idempotencyKey ?? input.idempotencyKey;
        yield* sql`INSERT INTO usage_reset_credit_requests (provider_instance_id, idempotency_key, grant_id) VALUES (${identity}, ${key}, ${requestedGrant}) ON CONFLICT DO NOTHING`;
        const result = yield* redeem(key, requestedGrant ?? undefined).pipe(
          Effect.timeout("30 seconds"),
          Effect.flatMap(Schema.decodeUnknownEffect(UsageConsumeResetCreditResult)),
        );
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE usage_reset_credit_requests SET result_json = ${JSON.stringify(result)} WHERE provider_instance_id = ${identity} AND idempotency_key = ${key}`;
            if (key !== input.idempotencyKey)
              yield* sql`INSERT INTO usage_reset_credit_requests (provider_instance_id, idempotency_key, grant_id, result_json) VALUES (${identity}, ${input.idempotencyKey}, ${requestedGrant}, ${JSON.stringify(result)}) ON CONFLICT DO NOTHING`;
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
