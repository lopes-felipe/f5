import { it, assert } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as SqliteClient from "../persistence/NodeSqliteClient";
import { ServerSettingsService } from "../serverSettings";
import { browserAccessAllowed } from "./browserAccess";
it.effect("uses live project overrides and fails closed on storage errors", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE projection_threads(thread_id TEXT,project_id TEXT)`;
    yield* sql`INSERT INTO projection_threads VALUES('one','project-one'),('two','project-two')`;
    const settings = yield* ServerSettingsService;
    const one = ThreadId.makeUnsafe("one"),
      two = ThreadId.makeUnsafe("two");
    assert.equal(yield* browserAccessAllowed(one), true);
    yield* settings.updateSettings({
      enableAgentBrowserAccess: false,
      projectSettingsOverrides: {
        [ProjectId.makeUnsafe("project-two")]: { enableAgentBrowserAccess: true },
      },
    });
    assert.equal(yield* browserAccessAllowed(one), false);
    assert.equal(yield* browserAccessAllowed(two), true);
    yield* settings.updateSettings({
      projectSettingsOverrides: {
        [ProjectId.makeUnsafe("project-two")]: { enableAgentBrowserAccess: false },
      },
    });
    assert.equal(yield* browserAccessAllowed(two), false);
    yield* sql`DROP TABLE projection_threads`;
    assert.equal(yield* browserAccessAllowed(one), false);
  }).pipe(
    Effect.provide(Layer.mergeAll(SqliteClient.layerMemory(), ServerSettingsService.layerTest())),
  ),
);
