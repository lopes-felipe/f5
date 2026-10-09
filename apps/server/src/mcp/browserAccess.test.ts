import { it, assert } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as SqliteClient from "../persistence/NodeSqliteClient";
import { ServerSettingsService } from "../serverSettings";
import { browserAccessAllowed, resolveAgentBrowserPolicy } from "./browserAccess";
it.effect("ANDs every agent capability with the browser access master switch", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE projection_threads(thread_id TEXT,project_id TEXT)`;
    yield* sql`INSERT INTO projection_threads VALUES('one','project-one')`;
    const settings = yield* ServerSettingsService;
    const one = ThreadId.makeUnsafe("one");
    const defaults = yield* resolveAgentBrowserPolicy(one);
    assert.deepEqual(defaults, {
      previewAutomation: true,
      externalHosts: [],
      claudeInChrome: false,
      computerUse: false,
    });
    yield* settings.updateSettings({
      previewExternalHosts: ["example.com"],
      enableClaudeInChrome: true,
      projectSettingsOverrides: {
        [ProjectId.makeUnsafe("project-one")]: {
          previewExternalHosts: ["*.example.org"],
          enableAgentComputerUse: true,
        },
      },
    });
    assert.deepEqual(yield* resolveAgentBrowserPolicy(one), {
      previewAutomation: true,
      externalHosts: ["*.example.org"],
      claudeInChrome: true,
      computerUse: true,
    });
    yield* settings.updateSettings({ enableAgentBrowserAccess: false });
    assert.deepEqual(yield* resolveAgentBrowserPolicy(one), {
      previewAutomation: false,
      externalHosts: [],
      claudeInChrome: false,
      computerUse: false,
    });
  }).pipe(
    Effect.provide(Layer.mergeAll(SqliteClient.layerMemory(), ServerSettingsService.layerTest())),
  ),
);
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
