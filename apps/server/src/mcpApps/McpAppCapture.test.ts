import { EventId, ProviderItemId, ThreadId, TurnId, type ProviderEvent } from "@t3tools/contracts";
import { MCP_APP_MIME_TYPE } from "@t3tools/shared/mcpApp";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Fiber, Layer, Scope, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexAppServerManager } from "../codexAppServerManager.ts";
import { makeCodexAdapter } from "../provider/Layers/CodexAdapter.ts";
import { runtimeEventToActivities } from "../orchestration/Layers/ProviderRuntimeIngestion.ts";
const threadId = ThreadId.makeUnsafe("app-capture-thread");
const at = "2026-10-19T12:00:00.000Z";
class CaptureManager extends CodexAppServerManager {
  finish: ((value: unknown) => void) | undefined;
  entered: (() => void) | undefined;
  readonly reading = new Promise<void>((resolve) => {
    this.entered = resolve;
  });
  override getMcpAppSessionIdentity() {
    return "capture-session";
  }
  override readMcpAppResource(): Promise<unknown> {
    this.entered?.();
    return new Promise((resolve) => {
      this.finish = resolve;
    });
  }
  fire(event: ProviderEvent) {
    return Promise.all(this.listeners("event").map((listener) => listener(event)));
  }
}
const event = (method: string, payload: unknown, id: string): ProviderEvent => ({
  id: EventId.makeUnsafe(id),
  provider: "codex",
  kind: "notification",
  threadId,
  turnId: TurnId.makeUnsafe("app-turn"),
  itemId: ProviderItemId.makeUnsafe("app-item"),
  createdAt: at,
  method,
  payload,
});
const completed = event(
  "item/completed",
  {
    item: {
      id: "app-item",
      type: "mcpToolCall",
      status: "completed",
      server: "weather",
      tool: "forecast",
      arguments: { city: "Berlin" },
      result: { content: [{ type: "text", text: "Sunny" }] },
      mcpAppUi: { resourceUri: "ui://weather/app" },
    },
  },
  "app-completed",
);
const layer = Layer.mergeAll(
  SqlitePersistenceMemory,
  ServerConfig.layerTest(process.cwd(), { prefix: "f5-app-capture-" }),
).pipe(Layer.provideMerge(NodeServices.layer));
it.effect("stores an owned app snapshot before admitting terminal turn completion", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,default_model,scripts_json,created_at,updated_at,deleted_at) VALUES('project','P','/tmp',NULL,'[]',${at},${at},NULL)`;
      yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,model,branch,worktree_path,latest_turn_id,archived_at,created_at,last_interaction_at,updated_at,deleted_at) VALUES(${threadId},'project','T','gpt-5',NULL,NULL,NULL,NULL,${at},${at},${at},NULL)`;
      const manager = new CaptureManager();
      const adapter = yield* makeCodexAdapter({ manager });
      const observed: string[] = [];
      const collecting = yield* adapter.streamEvents.pipe(
        Stream.take(2),
        Stream.tap((entry) =>
          Effect.sync(() => {
            observed.push(entry.type);
          }),
        ),
        Stream.runCollect,
        Effect.forkChild,
      );
      const first = manager.fire(completed);
      yield* Effect.promise(() => manager.reading);
      const terminal = manager.fire(
        event("turn/completed", { turn: { id: "app-turn", status: "completed" } }, "app-terminal"),
      );
      assert.deepStrictEqual(observed, []);
      manager.finish?.({
        contents: [
          { uri: "ui://weather/app", mimeType: MCP_APP_MIME_TYPE, text: "<p>Weather</p>" },
        ],
      });
      yield* Effect.promise(() => Promise.all([first, terminal]));
      const events = yield* Fiber.join(collecting);
      assert.deepStrictEqual(
        events.map((entry) => entry.type),
        ["item.completed", "turn.completed"],
      );
      const app = runtimeEventToActivities(events[0]!).find(
        (activity) => activity.kind === "mcpApp",
      );
      assert.isDefined(app);
      const rows = yield* sql<{
        activityId: string;
      }>`SELECT activity_id AS "activityId" FROM mcp_app_instances`;
      assert.equal(rows[0]?.activityId, app!.id);
      const owners =
        yield* sql`SELECT 1 FROM attachment_owners WHERE owner_kind='activity' AND owner_id=${app!.id}`;
      assert.lengthOf(owners, 1);
    }),
  ).pipe(Effect.provide(layer)),
);
// Live clock: closing the adapter waits a bounded real time for pending
// preparation before it aborts the capture.
it.live("interrupts a pending capture when the adapter scope closes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const manager = new CaptureManager();
      yield* makeCodexAdapter({ manager }).pipe(Scope.provide(scope));
      const first = manager.fire(completed);
      yield* Effect.promise(() => manager.reading);
      yield* Scope.close(scope, Exit.void);
      // The aborted preparation settles as an interruption.
      yield* Effect.promise(() => Promise.allSettled([first]));
      assert.equal(manager.listenerCount("event"), 0);
    }),
  ).pipe(Effect.provide(layer)),
);
