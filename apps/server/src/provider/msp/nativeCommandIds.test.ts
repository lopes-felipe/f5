import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { NATIVE_COMMAND_ID_RETENTION_MS, sqlNativeCommandIdStore } from "./nativeCommandIds.ts";

const layer = it.layer(SqlitePersistenceMemory);

layer("sqlNativeCommandIdStore", (it) => {
  it.effect("reuses the stored id until it is forgotten", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = sqlNativeCommandIdStore(sql);
      let minted = 0;
      const mint = () => `native-${++minted}`;
      const resolve = () =>
        store.resolve({ providerInstanceId: "muse", f5CommandId: "delivery-reuse", mint });
      const first = yield* resolve();
      assert.equal(yield* resolve(), first);
      yield* store.forget("delivery-reuse");
      assert.notEqual(yield* resolve(), first);
    }),
  );

  it.effect("prunes rows past the retention window", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      let now = Date.parse("2026-01-01T00:00:00.000Z");
      const store = sqlNativeCommandIdStore(sql, () => now);
      yield* store.resolve({
        providerInstanceId: "muse-prune",
        f5CommandId: "delivery-old",
        mint: () => "native-old",
      });
      now += NATIVE_COMMAND_ID_RETENTION_MS + 2 * 60 * 60 * 1000;
      yield* store.resolve({
        providerInstanceId: "muse-prune",
        f5CommandId: "delivery-new",
        mint: () => "native-new",
      });
      const rows = yield* sql<{ readonly f5_command_id: string }>`
        SELECT f5_command_id FROM provider_native_command_ids
        WHERE provider_instance_id = 'muse-prune'`;
      assert.deepEqual(
        rows.map((row) => row.f5_command_id),
        ["delivery-new"],
      );
    }),
  );
});
