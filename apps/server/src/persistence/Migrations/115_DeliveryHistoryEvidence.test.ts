import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../Layers/Sqlite";
import migration from "./115_DeliveryHistoryEvidence";

it.layer(SqlitePersistenceMemory)("delivery reservation backfill", (it) => {
  it.effect("releases historical accepted owners without revoking the active native turn", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const status of ["ready", "error", "stopped", "running", "starting"]) {
        yield* sql`INSERT INTO projection_thread_sessions(thread_id, status, active_turn_id, updated_at) VALUES (${status}, ${status}, 'native', '2026-01-01')`;
        yield* sql`INSERT INTO provider_turn_deliveries(delivery_id, command_id, thread_id, message_id, state, provider_turn_id, event_json, created_at, updated_at)
        VALUES (${status}, ${status}, ${status}, ${status}, 'accepted', 'native', '{}', '2026-01-01', '2026-01-01')`;
      }
      yield* migration;
      yield* migration;
      const remaining = yield* sql<{
        deliveryId: string;
      }>`SELECT delivery_id AS "deliveryId" FROM provider_turn_deliveries WHERE reservation_released_at IS NULL ORDER BY delivery_id`;
      assert.deepEqual(
        remaining.map((row) => row.deliveryId),
        ["running", "starting"],
      );
    }),
  );
});
