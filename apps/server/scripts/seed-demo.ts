#!/usr/bin/env bun
/**
 * seed-demo.ts — Populate an isolated F5 SQLite database with realistic-looking
 * demo data so that the desktop app can be screenshotted publicly without
 * exposing any real chats or projects.
 *
 * Usage:
 *   F5_STATE_DIR=/tmp/f5-demo/state bun run apps/server/scripts/seed-demo.ts
 *
 * Refuses to run if F5_STATE_DIR/T3CODE_STATE_DIR is unset OR points inside
 * the user's real F5 or legacy T3 state roots — guard against accidentally
 * writing to the real database.
 */
import * as FS from "node:fs";
import * as Path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointRef,
  CodeReviewWorkflowId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  OrchestrationCommandExecutionId,
  OrchestrationFileChangeId,
  PlanningWorkflowId,
  ProjectId,
  ThreadId,
  TurnId,
  type CodeReviewWorkflow,
  type OrchestrationCheckpointFile,
  type PlanningWorkflow,
  type ProviderInteractionMode,
  type TaskItem,
  type WorkflowModelSlot,
} from "@t3tools/contracts";
import { isProtectedAppStateDir } from "@t3tools/shared/appStatePaths";
import { Effect, Layer, Logger, ManagedRuntime } from "effect";

import { ServerConfig } from "../src/config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";

// ---------------------------------------------------------------------------
// Isolation guard: refuse to run unless an explicit, non-default state dir is
// provided. This is the single most important safety net — without it, a
// careless invocation could overwrite the user's real database.
// ---------------------------------------------------------------------------

const stateDir = process.env.F5_STATE_DIR?.trim() || process.env.T3CODE_STATE_DIR?.trim();
if (!stateDir) {
  console.error(
    "[seed-demo] Refusing to seed: F5_STATE_DIR/T3CODE_STATE_DIR is not set.\n" +
      "             Set it to an isolated path like /tmp/f5-demo/state.",
  );
  process.exit(1);
}

const normalized = Path.resolve(stateDir);
if (isProtectedAppStateDir(normalized)) {
  console.error(
    `[seed-demo] Refusing to seed: F5_STATE_DIR/T3CODE_STATE_DIR (${stateDir}) points inside the real F5/T3 state directory.\n` +
      "             Pick a throwaway path like /tmp/f5-demo/state instead.",
  );
  process.exit(1);
}

// Workspace stub directories live next to the state dir so that the entire
// demo tree is removable with a single `rm -rf` of the parent.
const baseDir = Path.dirname(normalized);
const workspacesDir = Path.join(baseDir, "workspaces");
FS.mkdirSync(workspacesDir, { recursive: true });

const project1Dir = Path.join(workspacesDir, "snippet-store");
const project2Dir = Path.join(workspacesDir, "rss-reader");
const project3Dir = Path.join(workspacesDir, "todo-cli");
for (const dir of [project1Dir, project2Dir, project3Dir]) {
  FS.mkdirSync(dir, { recursive: true });
}

console.log(`[seed-demo] state dir : ${normalized}`);
console.log(`[seed-demo] workspaces: ${workspacesDir}`);

// ---------------------------------------------------------------------------
// Demo identifiers — stable strings so re-seeds are reproducible.
// ---------------------------------------------------------------------------

const PROJECT_SNIPPET = ProjectId.makeUnsafe("project-snippet-store");
const PROJECT_RSS = ProjectId.makeUnsafe("project-rss-reader");
const PROJECT_TODO = ProjectId.makeUnsafe("project-todo-cli");

// snippet-store threads
const THREAD_SNIPPET_PG = ThreadId.makeUnsafe("thread-snippet-postgres");
const THREAD_SNIPPET_RACE = ThreadId.makeUnsafe("thread-snippet-race");

// rss-reader threads (chat + planning author + planning merge + impl + code-review)
const THREAD_RSS_OPML = ThreadId.makeUnsafe("thread-rss-opml");
const THREAD_RSS_AUTHOR_A = ThreadId.makeUnsafe("thread-rss-author-a");
const THREAD_RSS_AUTHOR_B = ThreadId.makeUnsafe("thread-rss-author-b");
const THREAD_RSS_MERGE = ThreadId.makeUnsafe("thread-rss-merge");
const THREAD_RSS_IMPLEMENTATION = ThreadId.makeUnsafe("thread-rss-implementation");
const THREAD_RSS_IMPL_REVIEWER_A = ThreadId.makeUnsafe("thread-rss-impl-reviewer-a");
const THREAD_RSS_IMPL_REVIEWER_B = ThreadId.makeUnsafe("thread-rss-impl-reviewer-b");

// todo-cli threads (chat + reviewer + reviewer + consolidation)
const THREAD_TODO_DUE = ThreadId.makeUnsafe("thread-todo-due-dates");
const THREAD_TODO_REVIEWER_A = ThreadId.makeUnsafe("thread-todo-reviewer-a");
const THREAD_TODO_REVIEWER_B = ThreadId.makeUnsafe("thread-todo-reviewer-b");
const THREAD_TODO_CONSOLIDATION = ThreadId.makeUnsafe("thread-todo-consolidation");

// "Plan ready" demo threads — assistant has produced a proposed plan that is
// awaiting the user's accept/revise decision. The session is `ready` but a
// proposed-plan event sits on the thread, and the thread's `interactionMode`
// is set to `"plan"` so the desktop renders the yellow "Plan Ready" status
// pill on the sidebar row.
const THREAD_SNIPPET_PLAN_READY = ThreadId.makeUnsafe("thread-snippet-plan-ready");
const THREAD_RSS_PLAN_READY = ThreadId.makeUnsafe("thread-rss-plan-ready");

// "Interrupted" demo thread — the user stopped the assistant mid-thought, so
// the session is in the `interrupted` state. The turn was completed cleanly
// before the interruption so no dangling pending turn remains.
const THREAD_RSS_INTERRUPTED = ThreadId.makeUnsafe("thread-rss-interrupted");

// "Running" demo thread — the assistant is actively producing a response
// right now: the turn has been started, partial deltas have streamed in, a
// command is mid-execution, but no `assistant.complete`/`turn.diff.complete`
// has fired yet. The session row carries `status: "running"`. Safe because
// the reactor only reacts to dispatched commands, not persisted session
// status — it will not try to resume the dangling turn on desktop boot.
const THREAD_TODO_RUNNING = ThreadId.makeUnsafe("thread-todo-running");

const PLANNING_WORKFLOW_ID = PlanningWorkflowId.makeUnsafe("workflow-rss-parallel-refresh");
const CODE_REVIEW_WORKFLOW_ID = CodeReviewWorkflowId.makeUnsafe("review-todo-kanban-pr");

// ---------------------------------------------------------------------------
// Time helpers — anchor demo timestamps to a fixed point so screenshots show
// consistent "x minutes ago" / "yesterday" relative formatting.
// ---------------------------------------------------------------------------

const now = new Date();
const isoMinutesAgo = (minutes: number): string =>
  new Date(now.getTime() - minutes * 60_000).toISOString();
const isoHoursAgo = (hours: number): string => isoMinutesAgo(hours * 60);
const isoDaysAgo = (days: number): string => isoMinutesAgo(days * 60 * 24);

let commandCounter = 0;
const cmd = (label: string): typeof CommandId.Type =>
  CommandId.makeUnsafe(`server:seed:${++commandCounter}:${label}`);

// ---------------------------------------------------------------------------
// Hand-written demo conversations. No proprietary references.
// ---------------------------------------------------------------------------

interface DemoCommandTranscript {
  readonly id: string;
  readonly command: string;
  readonly title: string;
  readonly cwd: string;
  readonly chunks: ReadonlyArray<string>;
  readonly exitCode: number;
  readonly status: "completed" | "failed";
  readonly startedAt: string;
  readonly completedAt: string;
}

interface DemoFileChange {
  readonly id: string;
  readonly title: string;
  readonly detail: string | null;
  readonly changedFiles: ReadonlyArray<string>;
  readonly patch: string;
  readonly checkpointFile: OrchestrationCheckpointFile;
  readonly startedAt: string;
  readonly completedAt: string;
}

interface DemoChat {
  readonly threadId: typeof ThreadId.Type;
  readonly projectId: typeof ProjectId.Type;
  readonly title: string;
  readonly model: string;
  readonly worktreePath: string;
  readonly createdAt: string;
  readonly userMessage: string;
  readonly assistantMessage: string;
  readonly turnCompletedAt: string;
  /**
   * Defaults to `"default"` (the conversational mode). Use `"plan"` for
   * plan-mode threads — combined with a non-implemented `proposedPlan`,
   * the desktop renders the yellow "Plan Ready" status pill on the thread
   * row in the sidebar.
   */
  readonly interactionMode?: ProviderInteractionMode;
  readonly commandTranscripts?: ReadonlyArray<DemoCommandTranscript>;
  readonly fileChanges?: ReadonlyArray<DemoFileChange>;
  readonly tasks?: ReadonlyArray<TaskItem>;
  /**
   * If set, the session ends in a non-`ready` state. The completion-of-turn
   * sequence still fires (so no pending turn dangles), but the session row
   * carries this status afterwards. Use `"interrupted"` to demonstrate the
   * "user stopped me mid-thought" UI affordance.
   */
  readonly finalSessionStatus?: "ready" | "interrupted";
  /**
   * Optional proposed plan upserted at the end of the turn. Demonstrates the
   * "plan ready — accept or revise" UI affordance.
   */
  readonly proposedPlan?: {
    readonly id: string;
    readonly planMarkdown: string;
    readonly upsertedAt: string;
  };
  /**
   * When true, leaves the turn dangling: no `assistant.complete`, no
   * `turn.diff.complete`. Final session ends in `running` state with an
   * active turn id. Demonstrates the "assistant currently working" UI.
   *
   * Any `commandTranscripts` on this chat are recorded with their final
   * status untouched — pass `status: "running"` to show a streaming command
   * with no exit code yet.
   *
   * Safe because the reactor only reacts to dispatched commands, not
   * persisted session state — it will not try to resume the dangling turn
   * on desktop boot.
   */
  readonly inProgress?: boolean;
}

const DEMO_CHATS: ReadonlyArray<DemoChat> = [
  {
    threadId: THREAD_SNIPPET_PG,
    projectId: PROJECT_SNIPPET,
    title: "Add Postgres backend support",
    model: "gpt-5-codex",
    worktreePath: project1Dir,
    createdAt: isoHoursAgo(6),
    userMessage:
      "Right now SnippetStore only supports SQLite. I want to add a Postgres adapter behind the same `StorageAdapter` interface. The adapter should support both `pg` and `postgres.js` clients via a small driver shim, and the migration tool should pick the right dialect from the connection URL.",
    assistantMessage: [
      "Plan:",
      "",
      "1. Look at `src/adapters/sqlite.ts` for the existing pattern. The `StorageAdapter` interface exposes `get`, `put`, `delete`, `list`, and `withTransaction`.",
      "2. Introduce `src/adapters/postgres/index.ts` exporting a `PostgresAdapter` class. Driver-agnostic: takes a thin `Client` interface that both `pg.Pool` and `postgres.Sql` can satisfy through small adapter modules in `src/adapters/postgres/drivers/`.",
      "3. Schema differences from SQLite:",
      "   - `JSONB` instead of `TEXT` for the value column.",
      "   - `BYTEA` instead of `BLOB` for binary snippets.",
      "   - `INSERT ... ON CONFLICT DO UPDATE` rather than `INSERT OR REPLACE`.",
      "4. Migration tool: parse `postgres://` vs `sqlite://` from the URL, pick a dialect-specific migrator. Both share the same logical migration files but render different DDL.",
      "5. Tests: extend `tests/adapters/contract.test.ts` to run the same suite against an ephemeral Postgres instance via `pg-mem` to avoid flakiness in CI.",
      "",
      "Want me to proceed with that shape, or would you rather keep the driver shim out and pick `postgres.js` only?",
    ].join("\n"),
    turnCompletedAt: isoHoursAgo(6),
    commandTranscripts: [
      {
        id: "exec-snippet-pg-grep",
        command: "rg -n 'StorageAdapter' src/",
        title: "rg -n 'StorageAdapter' src/",
        cwd: project1Dir,
        chunks: [
          "src/adapters/sqlite.ts:14:export class SqliteAdapter implements StorageAdapter {\n",
          "src/adapters/index.ts:3:export interface StorageAdapter {\n",
          "src/adapters/index.ts:11:export type StorageAdapterFactory = (url: string) => Promise<StorageAdapter>;\n",
          'src/store.ts:8:import type { StorageAdapter } from "./adapters";\n',
          "src/store.ts:21:  constructor(private readonly adapter: StorageAdapter) {}\n",
        ],
        exitCode: 0,
        status: "completed",
        startedAt: isoHoursAgo(6),
        completedAt: isoHoursAgo(6),
      },
      {
        id: "exec-snippet-pg-pg-mem-install",
        command: "bun add -d pg-mem",
        title: "bun add -d pg-mem",
        cwd: project1Dir,
        chunks: [
          "bun add v1.1.34 (a16fa4f7)\n\n",
          "installed pg-mem@2.8.1\n\n",
          "1 package installed [413.00ms]\n",
        ],
        exitCode: 0,
        status: "completed",
        startedAt: isoHoursAgo(6),
        completedAt: isoHoursAgo(6),
      },
    ],
    fileChanges: [
      {
        id: "fc-snippet-pg-adapter",
        title: "Add src/adapters/postgres/index.ts",
        detail: "Driver-agnostic Postgres adapter implementing StorageAdapter",
        changedFiles: ["src/adapters/postgres/index.ts"],
        checkpointFile: {
          path: "src/adapters/postgres/index.ts",
          kind: "added",
          additions: 38,
          deletions: 0,
        },
        patch: [
          "diff --git a/src/adapters/postgres/index.ts b/src/adapters/postgres/index.ts",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/src/adapters/postgres/index.ts",
          "@@ -0,0 +1,38 @@",
          '+import type { StorageAdapter } from "../index";',
          "+",
          "+export interface PgClient {",
          "+  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;",
          "+  end(): Promise<void>;",
          "+}",
          "+",
          "+export class PostgresAdapter implements StorageAdapter {",
          "+  constructor(private readonly client: PgClient) {}",
          "+",
          "+  async get(key: string): Promise<Uint8Array | null> {",
          "+    const { rows } = await this.client.query<{ value: Buffer }>(",
          '+      "SELECT value FROM snippets WHERE key = $1",',
          "+      [key],",
          "+    );",
          "+    return rows[0]?.value ?? null;",
          "+  }",
          "+",
          "+  async put(key: string, value: Uint8Array): Promise<void> {",
          "+    await this.client.query(",
          "+      `INSERT INTO snippets (key, value)",
          "+         VALUES ($1, $2)",
          "+         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,",
          "+      [key, value],",
          "+    );",
          "+  }",
          "+",
          "+  async delete(key: string): Promise<void> {",
          '+    await this.client.query("DELETE FROM snippets WHERE key = $1", [key]);',
          "+  }",
          "+",
          "+  async list(prefix: string): Promise<string[]> {",
          "+    const { rows } = await this.client.query<{ key: string }>(",
          '+      "SELECT key FROM snippets WHERE key LIKE $1 ORDER BY key",',
          '+      [prefix + "%"],',
          "+    );",
          "+    return rows.map((row) => row.key);",
          "+  }",
          "+}",
          "",
        ].join("\n"),
        startedAt: isoHoursAgo(6),
        completedAt: isoHoursAgo(6),
      },
      {
        id: "fc-snippet-pg-factory",
        title: "Edit src/adapters/index.ts",
        detail: "Pick adapter by URL scheme (sqlite:// vs postgres://)",
        changedFiles: ["src/adapters/index.ts"],
        checkpointFile: {
          path: "src/adapters/index.ts",
          kind: "modified",
          additions: 9,
          deletions: 1,
        },
        patch: [
          "diff --git a/src/adapters/index.ts b/src/adapters/index.ts",
          "--- a/src/adapters/index.ts",
          "+++ b/src/adapters/index.ts",
          "@@ -10,6 +10,14 @@ export interface StorageAdapter {",
          " ",
          " export type StorageAdapterFactory = (url: string) => Promise<StorageAdapter>;",
          " ",
          "-export const adapterFor: StorageAdapterFactory = async (url) => {",
          "-  return new SqliteAdapter(url);",
          "+export const adapterFor: StorageAdapterFactory = async (url) => {",
          '+  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {',
          '+    const { PostgresAdapter } = await import("./postgres");',
          '+    const { connect } = await import("./postgres/drivers/pg");',
          "+    return new PostgresAdapter(await connect(url));",
          "+  }",
          '+  if (url.startsWith("sqlite://")) {',
          "+    return new SqliteAdapter(url);",
          "+  }",
          "+  throw new Error(`unsupported storage URL: ${url}`);",
          " };",
          "",
        ].join("\n"),
        startedAt: isoHoursAgo(6),
        completedAt: isoHoursAgo(6),
      },
    ],
  },
  {
    threadId: THREAD_SNIPPET_RACE,
    projectId: PROJECT_SNIPPET,
    title: "Fix race condition in concurrent writes",
    model: "claude-sonnet-4-5",
    worktreePath: project1Dir,
    createdAt: isoDaysAgo(1),
    userMessage:
      "I'm seeing intermittent test failures in `concurrent-writes.test.ts`. Looks like two `put` calls with the same key sometimes both think they won. Stack trace below — can you find the race?\n\n```\nAssertionError: expected 'value-2' to equal 'value-1'\n  at concurrent-writes.test.ts:42\n```",
    assistantMessage: [
      "The race is in `lockKey()` in `src/adapters/sqlite.ts`. We read the row, decide whether to insert or update, and write — but the read and write are not in the same transaction. Two concurrent `put`s can both pass the existence check, both insert, and the second insert wins arbitrarily.",
      "",
      "Two ways to fix it depending on how strict you want to be:",
      "",
      "**Option A — wrap in `BEGIN IMMEDIATE` (SQLite-only):**",
      "```ts",
      'await this.db.exec("BEGIN IMMEDIATE");',
      "try {",
      '  const existing = await this.db.get("SELECT value FROM snippets WHERE key = ?", key);',
      "  if (existing) { /* update */ } else { /* insert */ }",
      '  await this.db.exec("COMMIT");',
      "} catch (err) {",
      '  await this.db.exec("ROLLBACK");',
      "  throw err;",
      "}",
      "```",
      "",
      "**Option B — collapse to a single `INSERT ... ON CONFLICT DO UPDATE`:**",
      "Avoids the read entirely; the engine guarantees atomicity. This is what I'd ship — it's also the same pattern Postgres needs (per the other thread).",
      "",
      "Want me to apply Option B and update the contract test to assert last-writer-wins semantics?",
    ].join("\n"),
    turnCompletedAt: isoDaysAgo(1),
    commandTranscripts: [
      // First run: reproduces the race (test fails). Demonstrates the red
      // "failed" UI badge and a non-zero exit code in the transcript header.
      {
        id: "exec-snippet-race-test-failing",
        command: "bun test src/adapters/concurrent-writes.test.ts",
        title: "bun test src/adapters/concurrent-writes.test.ts (reproducing the race)",
        cwd: project1Dir,
        chunks: [
          "bun test v1.1.34 (a16fa4f7)\n\nsrc/adapters/concurrent-writes.test.ts:\n",
          "(pass) put() is atomic under concurrent writers [11.92ms]\n",
          "(fail) put() preserves last-writer-wins [13.04ms]\n",
          "  AssertionError: expected 'value-2' to equal 'value-1'\n",
          "    at concurrent-writes.test.ts:42:5\n",
          "    at <anonymous> (concurrent-writes.test.ts:38:3)\n",
          "(pass) lockKey() is a no-op when storage is atomic [0.41ms]\n",
          "\n 2 pass\n 1 fail\n 8 expect() calls\n",
          "Ran 3 tests across 1 files. [231.00ms]\n",
          "error: 1 test(s) failed\n",
        ],
        exitCode: 1,
        status: "failed",
        startedAt: isoDaysAgo(1),
        completedAt: isoDaysAgo(1),
      },
      // Second run: after the upsert fix lands. All green.
      {
        id: "exec-snippet-race-test",
        command: "bun test src/adapters/concurrent-writes.test.ts",
        title: "bun test src/adapters/concurrent-writes.test.ts (after the fix)",
        cwd: project1Dir,
        chunks: [
          "bun test v1.1.34 (a16fa4f7)\n\nsrc/adapters/concurrent-writes.test.ts:\n",
          "(pass) put() is atomic under concurrent writers [12.41ms]\n",
          "(pass) put() preserves last-writer-wins [9.83ms]\n",
          "(pass) lockKey() is a no-op when storage is atomic [0.42ms]\n",
          "\n 3 pass\n 0 fail\n 8 expect() calls\n",
          "Ran 3 tests across 1 files. [218.00ms]\n",
        ],
        exitCode: 0,
        status: "completed",
        startedAt: isoDaysAgo(1),
        completedAt: isoDaysAgo(1),
      },
    ],
    fileChanges: [
      {
        id: "fc-snippet-race-sqlite",
        title: "Edit src/adapters/sqlite.ts",
        detail: "Replace read-then-write with atomic ON CONFLICT upsert",
        changedFiles: ["src/adapters/sqlite.ts"],
        checkpointFile: {
          path: "src/adapters/sqlite.ts",
          kind: "modified",
          additions: 8,
          deletions: 11,
        },
        patch: [
          "diff --git a/src/adapters/sqlite.ts b/src/adapters/sqlite.ts",
          "--- a/src/adapters/sqlite.ts",
          "+++ b/src/adapters/sqlite.ts",
          "@@ -38,18 +38,15 @@ export class SqliteAdapter implements StorageAdapter {",
          "   }",
          " ",
          "   async put(key: string, value: Uint8Array): Promise<void> {",
          "-    const existing = await this.db.get(",
          '-      "SELECT id FROM snippets WHERE key = ?",',
          "-      key,",
          "-    );",
          "-    if (existing) {",
          '-      await this.db.run("UPDATE snippets SET value = ? WHERE key = ?", value, key);',
          "-    } else {",
          '-      await this.db.run("INSERT INTO snippets (key, value) VALUES (?, ?)", key, value);',
          "-    }",
          "+    await this.db.run(",
          "+      `INSERT INTO snippets (key, value)",
          "+         VALUES (?, ?)",
          "+         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,",
          "+      key,",
          "+      value,",
          "+    );",
          "   }",
          " ",
          "-  async lockKey(key: string): Promise<() => void> {",
          "-    // Coarse-grained per-key lock to avoid races in put()",
          "-    return acquireLock(key);",
          "+  async lockKey(_key: string): Promise<() => void> {",
          "+    // No longer needed — `put` is atomic at the engine level.",
          "+    return () => {};",
          "   }",
          " }",
          "",
        ].join("\n"),
        startedAt: isoDaysAgo(1),
        completedAt: isoDaysAgo(1),
      },
    ],
  },
  {
    threadId: THREAD_RSS_OPML,
    projectId: PROJECT_RSS,
    title: "OPML import",
    model: "claude-sonnet-4-5",
    worktreePath: project2Dir,
    createdAt: isoHoursAgo(36),
    userMessage:
      "Can we add OPML import to the CLI? Should accept a file path or stdin and add each feed to the store with its category. If a feed already exists by URL, skip it but log a warning. Bonus: a `--dry-run` flag.",
    assistantMessage: [
      "Adding `cargo run -- import opml <path>` and `cat feeds.opml | cargo run -- import opml -`.",
      "",
      "Approach:",
      "- New module `src/cli/import.rs` with subcommand parsed via `clap`.",
      "- Use the `opml` crate to walk the outline tree. Categories are derived from the parent outline title; nested categories are joined with `/`.",
      "- For each leaf with an `xmlUrl`, look up the feed by URL in `FeedStore::find_by_url`. If present, log `feed already exists: <title>` and skip.",
      "- `--dry-run` prints the same log output but never calls `FeedStore::add`.",
      "",
      "I left a TODO around HTML entities in feed titles — I'd rather decode them at display time than at import time, since the same feed XML may also need decoding.",
      "",
      "Patch is staged. Run `cargo test --test import_opml` to see two new tests covering nested categories and dedupe.",
    ].join("\n"),
    turnCompletedAt: isoHoursAgo(35),
    commandTranscripts: [
      {
        id: "exec-rss-opml-cargo-test",
        command: "cargo test --test import_opml",
        title: "cargo test --test import_opml",
        cwd: project2Dir,
        chunks: [
          "    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.42s\n",
          "     Running tests/import_opml.rs (target/debug/deps/import_opml-3f8a1b2c)\n\n",
          "running 4 tests\n",
          "test imports_flat_opml ... ok\n",
          "test imports_nested_categories ... ok\n",
          "test skips_existing_feed_by_url ... ok\n",
          "test dry_run_does_not_persist ... ok\n\n",
          "test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.08s\n",
        ],
        exitCode: 0,
        status: "completed",
        startedAt: isoHoursAgo(36),
        completedAt: isoHoursAgo(35),
      },
    ],
    fileChanges: [
      {
        id: "fc-rss-opml-cli",
        title: "Add src/cli/import.rs",
        detail: "OPML import subcommand with nested-category support",
        changedFiles: ["src/cli/import.rs"],
        checkpointFile: {
          path: "src/cli/import.rs",
          kind: "added",
          additions: 47,
          deletions: 0,
        },
        patch: [
          "diff --git a/src/cli/import.rs b/src/cli/import.rs",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/src/cli/import.rs",
          "@@ -0,0 +1,47 @@",
          "+use crate::store::FeedStore;",
          "+use anyhow::{Context, Result};",
          "+use clap::Args;",
          "+use opml::OPML;",
          "+use std::io::Read;",
          "+use std::path::PathBuf;",
          "+",
          "+#[derive(Args, Debug)]",
          "+pub struct ImportOpml {",
          '+    /// Path to an OPML file, or "-" to read from stdin.',
          "+    pub source: String,",
          "+",
          "+    /// Print actions without writing to the store.",
          "+    #[arg(long)]",
          "+    pub dry_run: bool,",
          "+}",
          "+",
          "+pub fn run(args: ImportOpml, store: &mut FeedStore) -> Result<()> {",
          '+    let xml = if args.source == "-" {',
          "+        let mut buf = String::new();",
          "+        std::io::stdin().read_to_string(&mut buf)?;",
          "+        buf",
          "+    } else {",
          "+        std::fs::read_to_string(PathBuf::from(&args.source))",
          '+            .with_context(|| format!("reading {}", args.source))?',
          "+    };",
          "+    let outline = OPML::from_str(&xml)?;",
          "+    walk(&outline.body.outlines, &mut Vec::new(), store, args.dry_run)?;",
          "+    Ok(())",
          "+}",
          "+",
          "+fn walk(outlines: &[opml::Outline], path: &mut Vec<String>, store: &mut FeedStore, dry: bool) -> Result<()> {",
          "+    for outline in outlines {",
          "+        if let Some(url) = &outline.xml_url {",
          "+            if store.find_by_url(url).is_some() {",
          '+                eprintln!("feed already exists: {}", outline.text);',
          "+                continue;",
          "+            }",
          "+            if !dry {",
          '+                store.add(url, &outline.text, &path.join("/"))?;',
          "+            }",
          "+        } else if !outline.outlines.is_empty() {",
          "+            path.push(outline.text.clone());",
          "+            walk(&outline.outlines, path, store, dry)?;",
          "+            path.pop();",
          "+        }",
          "+    }",
          "+    Ok(())",
          "+}",
          "",
        ].join("\n"),
        startedAt: isoHoursAgo(36),
        completedAt: isoHoursAgo(35),
      },
      {
        id: "fc-rss-opml-cli-mod",
        title: "Edit src/cli/mod.rs",
        detail: "Wire up new import subcommand",
        changedFiles: ["src/cli/mod.rs"],
        checkpointFile: {
          path: "src/cli/mod.rs",
          kind: "modified",
          additions: 5,
          deletions: 0,
        },
        patch: [
          "diff --git a/src/cli/mod.rs b/src/cli/mod.rs",
          "--- a/src/cli/mod.rs",
          "+++ b/src/cli/mod.rs",
          "@@ -1,11 +1,16 @@",
          " pub mod add;",
          "+pub mod import;",
          " pub mod list;",
          " ",
          " #[derive(clap::Subcommand, Debug)]",
          " pub enum Command {",
          "     Add(add::AddFeed),",
          "+    Import {",
          "+        #[command(subcommand)]",
          "+        kind: ImportKind,",
          "+    },",
          "     List(list::ListFeeds),",
          " }",
          "",
        ].join("\n"),
        startedAt: isoHoursAgo(36),
        completedAt: isoHoursAgo(35),
      },
    ],
  },
  {
    threadId: THREAD_TODO_DUE,
    projectId: PROJECT_TODO,
    title: "Add due dates",
    model: "gpt-5-codex",
    worktreePath: project3Dir,
    createdAt: isoMinutesAgo(90),
    userMessage:
      "Let's add optional due dates to todos. Storage is currently a single JSON file. CLI should accept `--due tomorrow`, `--due 2026-05-01`, or `--due 'next monday'`. Listing shows overdue items in red.",
    assistantMessage: [
      "Done. Summary of the change:",
      "",
      "- `Todo` struct gains `due: Option<DateTime<Local>>`.",
      "- `--due` parsing uses `chrono-english` for natural-language strings and falls back to `chrono::NaiveDate` parsing in ISO 8601 / `YYYY-MM-DD` format. Errors surface a friendly message: `couldn't parse due date 'asdf' — try 'tomorrow' or '2026-05-01'`.",
      "- `list` command: items where `due < now` render with `nu_ansi_term::Color::Red`. A small `(overdue, 2d)` suffix indicates how late.",
      "- Migration: existing JSON files are loaded with `serde(default)` so missing `due` becomes `None`. No on-disk schema bump needed.",
      "",
      "Tests covered:",
      "- `due_date_parsing` — round-trips a few natural-language inputs.",
      "- `overdue_rendering` — verifies the `(overdue, ...)` suffix using a frozen `now`.",
      "- `migration_from_legacy` — loads a v0 JSON file and confirms `due == None`.",
      "",
      "Open question: should we also add `--snooze 1d` to bump the due date forward? Happy to wire it up if so.",
    ].join("\n"),
    turnCompletedAt: isoMinutesAgo(85),
    tasks: [
      {
        id: "task-1",
        content: "Extend Todo struct with optional due field",
        activeForm: "Extending Todo struct with optional due field",
        status: "completed",
      },
      {
        id: "task-2",
        content: "Wire --due flag through CLI parser",
        activeForm: "Wiring --due flag through CLI parser",
        status: "completed",
      },
      {
        id: "task-3",
        content: "Render overdue items in red with relative-time suffix",
        activeForm: "Rendering overdue items in red with relative-time suffix",
        status: "completed",
      },
      {
        id: "task-4",
        content: "Cover migration_from_legacy and overdue_rendering with tests",
        activeForm: "Covering migration_from_legacy and overdue_rendering with tests",
        status: "completed",
      },
      {
        id: "task-5",
        content: "Document --due syntax in README quick-start",
        activeForm: "Documenting --due syntax in README quick-start",
        status: "in_progress",
      },
      {
        id: "task-6",
        content: "Decide whether to ship --snooze in the same release",
        activeForm: "Deciding whether to ship --snooze in the same release",
        status: "pending",
      },
    ],
    commandTranscripts: [
      {
        id: "exec-todo-due-cargo-test",
        command: "cargo test",
        title: "cargo test",
        cwd: project3Dir,
        chunks: [
          "    Compiling todo-cli v0.4.0 (/workspace/todo-cli)\n",
          "    Finished `test` profile [unoptimized + debuginfo] target(s) in 1.84s\n",
          "     Running unittests src/lib.rs (target/debug/deps/todo_cli-9c2e1f0a)\n\n",
          "running 11 tests\n",
          "test due_date::tests::parses_iso_8601 ... ok\n",
          "test due_date::tests::parses_natural_language ... ok\n",
          "test due_date::tests::reports_friendly_error ... ok\n",
          "test render::tests::overdue_rendering ... ok\n",
          "test render::tests::not_yet_due_rendering ... ok\n",
          "test storage::tests::migration_from_legacy ... ok\n",
          "test storage::tests::round_trips_due_field ... ok\n",
          "test cli::tests::add_with_due_flag ... ok\n",
          "test cli::tests::list_orders_by_due ... ok\n",
          "test cli::tests::list_omits_due_when_none ... ok\n",
          "test cli::tests::done_clears_due ... ok\n\n",
          "test result: ok. 11 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.09s\n",
        ],
        exitCode: 0,
        status: "completed",
        startedAt: isoMinutesAgo(88),
        completedAt: isoMinutesAgo(87),
      },
    ],
    fileChanges: [
      {
        id: "fc-todo-due-types",
        title: "Edit src/lib.rs",
        detail: "Add optional due field to Todo",
        changedFiles: ["src/lib.rs"],
        checkpointFile: {
          path: "src/lib.rs",
          kind: "modified",
          additions: 6,
          deletions: 1,
        },
        patch: [
          "diff --git a/src/lib.rs b/src/lib.rs",
          "--- a/src/lib.rs",
          "+++ b/src/lib.rs",
          "@@ -1,10 +1,15 @@",
          " use chrono::{DateTime, Local};",
          " use serde::{Deserialize, Serialize};",
          " ",
          " #[derive(Debug, Clone, Serialize, Deserialize)]",
          " pub struct Todo {",
          "     pub id: u32,",
          "     pub title: String,",
          "     pub done: bool,",
          "+",
          "+    /// Optional due date. `None` for legacy todos that pre-date this field.",
          '+    #[serde(default, skip_serializing_if = "Option::is_none")]',
          "+    pub due: Option<DateTime<Local>>,",
          "+",
          "     pub created_at: DateTime<Local>,",
          " }",
          "",
        ].join("\n"),
        startedAt: isoMinutesAgo(89),
        completedAt: isoMinutesAgo(88),
      },
      {
        id: "fc-todo-due-render",
        title: "Edit src/render.rs",
        detail: "Highlight overdue items in red with relative suffix",
        changedFiles: ["src/render.rs"],
        checkpointFile: {
          path: "src/render.rs",
          kind: "modified",
          additions: 14,
          deletions: 2,
        },
        patch: [
          "diff --git a/src/render.rs b/src/render.rs",
          "--- a/src/render.rs",
          "+++ b/src/render.rs",
          "@@ -22,8 +22,20 @@ pub fn render_line(todo: &Todo, now: DateTime<Local>) -> String {",
          '     let checkbox = if todo.done { "[x]" } else { "[ ]" };',
          '-    format!("{} {}. {}", checkbox, todo.id, todo.title)',
          '+    let base = format!("{} {}. {}", checkbox, todo.id, todo.title);',
          "+    match todo.due {",
          "+        Some(due) if !todo.done && due < now => {",
          "+            let suffix = relative_overdue(now - due);",
          '+            format!("{} {}", Color::Red.paint(base), Color::Red.paint(suffix))',
          "+        }",
          "+        Some(due) => {",
          '+            let suffix = format!("(due {})", due.format("%Y-%m-%d"));',
          '+            format!("{} {}", base, Color::DarkGray.paint(suffix))',
          "+        }",
          "+        None => base,",
          "+    }",
          " }",
          " ",
          "-fn relative_overdue(_delta: chrono::Duration) -> String { String::new() }",
          "+fn relative_overdue(delta: chrono::Duration) -> String {",
          "+    let days = delta.num_days().max(1);",
          '+    format!("(overdue, {}d)", days)',
          "+}",
          "",
        ].join("\n"),
        startedAt: isoMinutesAgo(89),
        completedAt: isoMinutesAgo(88),
      },
    ],
  },
  // -------------------------------------------------------------------------
  // "Plan ready" demo thread — assistant has produced a plan that is awaiting
  // the user's accept/reject decision. The session sits idle (`ready`) but a
  // proposed-plan event is attached.
  // -------------------------------------------------------------------------
  {
    threadId: THREAD_SNIPPET_PLAN_READY,
    projectId: PROJECT_SNIPPET,
    title: "Index cold-start optimization",
    model: "claude-sonnet-4-5",
    worktreePath: project1Dir,
    createdAt: isoMinutesAgo(25),
    interactionMode: "plan",
    userMessage:
      "First load of a fresh SnippetStore takes ~4s on a 50k-snippet dataset because we eagerly walk every row to build the search index. I want a plan to make this lazy without regressing search latency. Don't write code yet — just propose an approach.",
    assistantMessage: [
      "Drafted a two-phase plan below. It avoids the cold-start cost without making the first search pay for it.",
      "",
      "Hit **Accept** to drop me into implementation, or **Revise** if anything looks off — happy to redesign if you'd rather pick a different tradeoff.",
    ].join("\n"),
    turnCompletedAt: isoMinutesAgo(20),
    proposedPlan: {
      id: "plan-snippet-cold-start",
      planMarkdown: [
        "# Plan: Lazy index build with prefix-tier warm-up",
        "",
        "## Goal",
        "Eliminate the ~4s cold-start cost when opening a SnippetStore with 50k+ entries while keeping first-search latency < 80ms (current p95 = 60ms).",
        "",
        "## Approach",
        "",
        "**Phase 1 — defer full-text index construction:**",
        "Replace the eager `IndexBuilder::build_all()` call in `Store::open()` with a lightweight metadata scan that loads only `(id, key, updated_at)` tuples into a sorted `BTreeMap`. This is enough to render the snippet list and serve `get_by_key`. Cost on the same dataset: ~120ms.",
        "",
        "**Phase 2 — warm the inverted index in two tiers:**",
        "1. **Prefix tier** (synchronous, ≤200ms budget): build the trigram index for the most-recently-touched 1000 snippets. Covers ~95% of typical first-search queries based on telemetry from the desktop build.",
        "2. **Full tier** (background task): finish indexing the remaining snippets on a low-priority Tokio task. The search executor checks `index.is_complete_for(snippet)` and falls back to a linear scan over the unindexed tail (bounded — never more than `total - 1000` rows).",
        "",
        "## Public API impact",
        "- `Store::open()` becomes synchronous + cheap.",
        "- `Store::search(query)` is unchanged from the caller's perspective.",
        "- New observable: `Store::index_status()` returns `Building { progress: f32 } | Ready` — surfaces a small progress chip in the UI.",
        "",
        "## Risk",
        "- **Search latency regression on the cold tail.** Mitigated: linear scan is over at most ~49k entries which we measured at 30ms in release mode. Add a benchmark in `benches/cold_search.rs` to keep us honest.",
        "- **Concurrent writes during background indexing.** The store already holds a `RwLock` on the index — we just keep the build phase under the same lock. No additional contention because the background task drops the lock between every batch of 500 snippets.",
        "",
        "## Out of scope",
        "- Persisting the prebuilt index to disk. That's a separate, bigger change (touches the on-disk format) and the in-memory rebuild is now cheap enough to defer.",
        "- Switching from trigram to a learned ranker.",
        "",
        "## Test plan",
        "- New: `tests/cold_start.rs` — measures `Store::open()` wall time on a fixture of 50k snippets, asserts < 200ms.",
        "- New: `benches/cold_search.rs` — first-search latency before warm-up.",
        "- Existing: `tests/search/*` should continue to pass without modification.",
        "",
        "## Estimate",
        "~1 day. Most of the work is in `src/index/builder.rs` and a new `src/index/warmup.rs`.",
      ].join("\n"),
      upsertedAt: isoMinutesAgo(20),
    },
  },
  // -------------------------------------------------------------------------
  // Second "Plan ready" thread — different project (rss-reader), shorter
  // plan focused on a small refactor. Using `interactionMode: "plan"` plus
  // an unimplemented `proposedPlan` makes the desktop render the yellow
  // "Plan Ready" status pill on the sidebar row.
  // -------------------------------------------------------------------------
  {
    threadId: THREAD_RSS_PLAN_READY,
    projectId: PROJECT_RSS,
    title: "Switch HTTP client to reqwest::Client pool",
    model: "gpt-5-codex",
    worktreePath: project2Dir,
    createdAt: isoMinutesAgo(50),
    interactionMode: "plan",
    userMessage:
      "We construct a new `reqwest::Client` per refresh. That allocates a fresh connection pool, TLS context, and DNS cache each time, which I suspect is most of the per-feed latency. Plan a fix that hoists a single shared client without breaking the existing test fixtures. Don't write code yet.",
    assistantMessage: [
      "Plan below. Small surface area — most of the work is plumbing the shared client through `FeedRefresher`.",
      "",
      "Hit **Accept** to proceed, or **Revise** if you'd rather thread the client differently (e.g. via a global `OnceCell` rather than constructor injection — happy to switch).",
    ].join("\n"),
    turnCompletedAt: isoMinutesAgo(45),
    proposedPlan: {
      id: "plan-rss-shared-http-client",
      planMarkdown: [
        "# Plan: Hoist a shared `reqwest::Client` into `FeedRefresher`",
        "",
        "## Goal",
        "Eliminate the per-refresh client construction cost. Each feed refresh currently builds a fresh `reqwest::Client`, which sets up a connection pool, TLS context, and resolver from scratch — wasted work when refreshing many feeds in sequence.",
        "",
        "## Approach",
        "1. **Construct once at startup.** Build a `reqwest::Client` in `main.rs` with a sensible default config: 30s timeout, gzip enabled, a custom user-agent (`rss-reader/0.x`), and `pool_max_idle_per_host(4)`.",
        "2. **Inject into `FeedRefresher::new`.** Change the constructor signature from `new()` to `new(client: reqwest::Client)`. The struct stores a clone — `Client` is cheap to clone (it's an `Arc` internally).",
        "3. **Update tests.** `FeedRefresher` tests in `tests/refresh.rs` currently call `FeedRefresher::new()`. Add a `test_helpers::default_client()` that returns a `reqwest::Client` with a 1s timeout (so test failures fail fast). Existing test bodies stay unchanged.",
        "4. **Document the threading model.** Add a sentence to `docs/architecture.md` noting that `FeedRefresher` is `Send + Sync` (the underlying `reqwest::Client` is) so callers can put it behind an `Arc` and refresh feeds concurrently.",
        "",
        "## Risk",
        "- **Test isolation.** Tests that mock the network (via `wiremock`) need a fresh client per test, which is fine — `default_client()` returns one. The shared-client model is for production, not tests.",
        "- **Long-lived idle connections.** `pool_max_idle_per_host(4)` caps idle sockets. We're already polite (max 4 concurrent per host), so this matches the live concurrency.",
        "",
        "## Out of scope",
        "- Rate limiting (already exists per-host).",
        "- Switching from `reqwest` to `hyper` directly. The convenience of `reqwest`'s response decoding (gzip, JSON helpers) outweighs the small overhead for a feed reader.",
        "",
        "## Test plan",
        "- Existing: `cargo test --test refresh` — all green.",
        "- New micro-bench: `benches/refresh.rs` measuring 100-feed cold refresh before/after.",
        "  Expected: 4–6× speed-up dominated by TLS handshake reuse.",
        "",
        "## Estimate",
        "~2 hours. Mostly mechanical.",
      ].join("\n"),
      upsertedAt: isoMinutesAgo(45),
    },
  },
  // -------------------------------------------------------------------------
  // "Interrupted" demo thread — user stopped the assistant mid-thought. The
  // turn we DID complete is wrapped up properly (so no dangling pending
  // state), then the session is set to `interrupted` to surface the UI badge.
  // -------------------------------------------------------------------------
  {
    threadId: THREAD_RSS_INTERRUPTED,
    projectId: PROJECT_RSS,
    title: "Migrate config to TOML",
    model: "gpt-5-codex",
    worktreePath: project2Dir,
    createdAt: isoMinutesAgo(8),
    userMessage:
      "Let's move the user config from JSON to TOML. The current `~/.config/rss-reader/config.json` should be auto-migrated on first run, then deleted. Don't forget the schema docs.",
    assistantMessage: [
      "Outlining the migration path before I touch any code:",
      "",
      "1. Add a `toml` dependency and a new `Config` struct that derives `Deserialize` for both formats so we can read either during the transition.",
      "2. On startup, if `config.toml` is missing but `config.json` exists, parse the JSON, re-serialize as TOML, write `config.toml`, then unlink the JSON file. Log the action at INFO so the user knows the migration happened.",
      "3. Update `docs/config.md` with side-by-side examples — actually, wait, I should check whether",
    ].join("\n"),
    turnCompletedAt: isoMinutesAgo(7),
    finalSessionStatus: "interrupted",
  },
  // -------------------------------------------------------------------------
  // "Running" / "in-progress" demo thread — the assistant is mid-response
  // right now: partial delta streamed, a command transcript is actively
  // collecting output (status: "running"), and no completion events have
  // fired. The session ends in `status: "running"` with an active turn id,
  // so the desktop renders the typing indicator and live transcript chrome.
  // -------------------------------------------------------------------------
  {
    threadId: THREAD_TODO_RUNNING,
    projectId: PROJECT_TODO,
    title: "Add JSON export to the list command",
    model: "claude-sonnet-4-5",
    worktreePath: project3Dir,
    createdAt: isoMinutesAgo(2),
    userMessage:
      "Add a `--json` flag to the `list` command that emits each todo as a JSON Lines record on stdout. Should still respect the existing filters (`--all`, `--tag`). Make sure dates are ISO-8601, not the human-friendly format.",
    assistantMessage: [
      "Looking at the current list command in `src/cli/list.rs`. The render path bottoms out in `render_line(todo, now)` which formats a single human-readable string. I'll fork the path before that:",
      "",
      "1. Plumb a `--json` flag through `clap` on the `ListTodos` struct.",
      "2. Branch in `cli::list::run` — if `args.json` is set, serialize each todo via `serde_json::to_string` to stdout one line at a time. Otherwise call into the existing renderer.",
      "3. The `Todo` struct already derives `Serialize`, and `chrono::DateTime<Local>` serializes to ISO-8601 by default — so no extra work for date formatting.",
      "",
      "Running the existing test suite first to make sure nothing's broken before I",
    ].join("\n"),
    // Same as createdAt — but we never actually fire the completion events
    // for an in-progress turn, so this field is unused. We still need a
    // value because the type requires one.
    turnCompletedAt: isoMinutesAgo(2),
    inProgress: true,
    commandTranscripts: [
      {
        id: "exec-todo-running-cargo-test",
        command: "cargo test --lib",
        title: "cargo test --lib",
        cwd: project3Dir,
        chunks: [
          "    Compiling todo-cli v0.4.0 (/workspace/todo-cli)\n",
          "    Finished `test` profile [unoptimized + debuginfo] target(s) in 1.44s\n",
          "     Running unittests src/lib.rs (target/debug/deps/todo_cli-9c2e1f0a)\n\n",
          "running 11 tests\n",
          "test due_date::tests::parses_iso_8601 ... ok\n",
          "test due_date::tests::parses_natural_language ... ok\n",
          "test due_date::tests::reports_friendly_error ... ok\n",
          "test render::tests::overdue_rendering ... ok\n",
          "test render::tests::not_yet_due_rendering ... ok\n",
          // No final result line — transcript still streaming.
        ],
        // Stays at "running" — no exitCode yet. Triggers the live-output UI.
        exitCode: 0,
        status: "completed", // see below — overridden via inProgress branch
        startedAt: isoMinutesAgo(1),
        completedAt: isoMinutesAgo(1),
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Workflow helpers
// ---------------------------------------------------------------------------

const slot = (provider: "codex" | "claudeAgent", model: string): WorkflowModelSlot => ({
  provider,
  model,
});

// Full happy-path planning workflow:
//   Authoring ✓  →  Reviews ✓  →  Revision ✓  →  Merge ✓  →  Implementation ✓
//   →  Code Review ✓  →  Apply Reviews ✓
//
// Field values verified against `apps/web/src/workflowSidebarTimeline.ts`:
//   - branch.status === "revised"            → Authoring + Reviews + Revision green
//   - branch.reviews[].status === "completed" → review sub-rows green
//   - merge.status === "merged" + approvedPlanId set → Merge green
//   - implementation.status === "completed"  → Implementation + Apply Reviews green
//   - implementation.codeReviews[].status === "completed" → Code Review green
//   - error: null on all four entities       → header status not "Error"
const PLANNING_WORKFLOW: PlanningWorkflow = {
  id: PLANNING_WORKFLOW_ID,
  projectId: PROJECT_RSS,
  title: "Parallelize feed refresh",
  slug: "parallelize-feed-refresh",
  requirementPrompt:
    "We need to refresh RSS feeds in parallel without overwhelming any single host. Design a worker pool with per-host rate limiting (max 4 concurrent requests per host) and good failure isolation: a single feed throwing an error must never halt the rest of the batch. Refresh state should be observable via the existing `--verbose` flag.",
  plansDirectory: ".plans",
  selfReviewEnabled: true,
  branchA: {
    branchId: "a",
    authorSlot: slot("claudeAgent", "claude-sonnet-4-5"),
    authorThreadId: THREAD_RSS_AUTHOR_A,
    planFilePath: ".plans/parallelize-feed-refresh/branch-a.md",
    planTurnId: "turn-rss-author-a-plan",
    revisionTurnId: "turn-rss-author-a-revision",
    reviews: [
      {
        slot: "cross",
        threadId: THREAD_RSS_AUTHOR_B,
        outputFilePath: ".plans/parallelize-feed-refresh/branch-a.cross-review.md",
        status: "completed",
        error: null,
        updatedAt: isoHoursAgo(2),
      },
      {
        slot: "self",
        threadId: THREAD_RSS_AUTHOR_A,
        outputFilePath: ".plans/parallelize-feed-refresh/branch-a.self-review.md",
        status: "completed",
        error: null,
        updatedAt: isoMinutesAgo(110),
      },
    ],
    status: "revised",
    error: null,
    retryCount: 0,
    lastRetryAt: null,
    updatedAt: isoMinutesAgo(95),
  },
  branchB: {
    branchId: "b",
    authorSlot: slot("codex", "gpt-5-codex"),
    authorThreadId: THREAD_RSS_AUTHOR_B,
    planFilePath: ".plans/parallelize-feed-refresh/branch-b.md",
    planTurnId: "turn-rss-author-b-plan",
    revisionTurnId: "turn-rss-author-b-revision",
    reviews: [
      {
        slot: "cross",
        threadId: THREAD_RSS_AUTHOR_A,
        outputFilePath: ".plans/parallelize-feed-refresh/branch-b.cross-review.md",
        status: "completed",
        error: null,
        updatedAt: isoMinutesAgo(105),
      },
      {
        slot: "self",
        threadId: THREAD_RSS_AUTHOR_B,
        outputFilePath: ".plans/parallelize-feed-refresh/branch-b.self-review.md",
        status: "completed",
        error: null,
        updatedAt: isoMinutesAgo(100),
      },
    ],
    status: "revised",
    error: null,
    retryCount: 0,
    lastRetryAt: null,
    updatedAt: isoMinutesAgo(90),
  },
  merge: {
    mergeSlot: slot("claudeAgent", "claude-opus-4"),
    threadId: THREAD_RSS_MERGE,
    outputFilePath: ".plans/parallelize-feed-refresh/merged.md",
    turnId: "turn-rss-merge",
    approvedPlanId: "plan-rss-parallelize-feed-refresh-merged",
    status: "merged",
    error: null,
    updatedAt: isoMinutesAgo(75),
  },
  implementation: {
    implementationSlot: slot("claudeAgent", "claude-sonnet-4-5"),
    threadId: THREAD_RSS_IMPLEMENTATION,
    implementationTurnId: "turn-rss-implementation",
    revisionTurnId: "turn-rss-implementation-revision",
    codeReviewEnabled: true,
    codeReviews: [
      {
        reviewerLabel: "Claude review",
        reviewerSlot: slot("claudeAgent", "claude-sonnet-4-5"),
        threadId: THREAD_RSS_IMPL_REVIEWER_A,
        status: "completed",
        error: null,
        retryCount: 0,
        lastRetryAt: null,
        updatedAt: isoMinutesAgo(35),
      },
      {
        reviewerLabel: "Codex review",
        reviewerSlot: slot("codex", "gpt-5-codex"),
        threadId: THREAD_RSS_IMPL_REVIEWER_B,
        status: "completed",
        error: null,
        retryCount: 0,
        lastRetryAt: null,
        updatedAt: isoMinutesAgo(30),
      },
    ],
    status: "completed",
    error: null,
    retryCount: 0,
    lastRetryAt: null,
    updatedAt: isoMinutesAgo(15),
  },
  totalCostUsd: 1.42,
  createdAt: isoHoursAgo(3),
  updatedAt: isoMinutesAgo(15),
  archivedAt: null,
  deletedAt: null,
};

const CODE_REVIEW_WORKFLOW: CodeReviewWorkflow = {
  id: CODE_REVIEW_WORKFLOW_ID,
  projectId: PROJECT_TODO,
  title: "Review Kanban board view PR",
  slug: "review-kanban-board-view-pr",
  reviewPrompt:
    "Review the Kanban view implementation in `src/views/kanban.rs` for correctness, idiomatic Rust, and accessibility of keyboard navigation. Pay particular attention to the column-resize logic, the focus ring contrast, and whether the new `KanbanState` struct can ever observe a column count of zero.",
  branch: "feat/kanban-view",
  reviewerA: {
    label: "Claude Sonnet review",
    slot: slot("claudeAgent", "claude-sonnet-4-5"),
    threadId: THREAD_TODO_REVIEWER_A,
    status: "completed",
    pinnedTurnId: "turn-todo-reviewer-a",
    pinnedAssistantMessageId: "msg-todo-reviewer-a-final",
    error: null,
    updatedAt: isoMinutesAgo(15),
  },
  reviewerB: {
    label: "Codex review",
    slot: slot("codex", "gpt-5-codex"),
    threadId: THREAD_TODO_REVIEWER_B,
    status: "running",
    pinnedTurnId: null,
    pinnedAssistantMessageId: null,
    error: null,
    updatedAt: isoMinutesAgo(2),
  },
  consolidation: {
    slot: slot("claudeAgent", "claude-opus-4"),
    threadId: THREAD_TODO_CONSOLIDATION,
    status: "not_started",
    pinnedTurnId: null,
    pinnedAssistantMessageId: null,
    error: null,
    updatedAt: isoMinutesAgo(2),
  },
  createdAt: isoHoursAgo(1),
  updatedAt: isoMinutesAgo(2),
  archivedAt: null,
  deletedAt: null,
};

// ---------------------------------------------------------------------------
// Seed program
// ---------------------------------------------------------------------------

const seedProgram = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;

  // 1. Projects
  yield* engine.dispatch({
    type: "project.create",
    commandId: cmd("project-snippet"),
    projectId: PROJECT_SNIPPET,
    title: "snippet-store",
    workspaceRoot: project1Dir,
    defaultModel: "gpt-5-codex",
    createdAt: isoDaysAgo(7),
  });
  yield* engine.dispatch({
    type: "project.create",
    commandId: cmd("project-rss"),
    projectId: PROJECT_RSS,
    title: "rss-reader",
    workspaceRoot: project2Dir,
    defaultModel: "claude-sonnet-4-5",
    createdAt: isoDaysAgo(5),
  });
  yield* engine.dispatch({
    type: "project.create",
    commandId: cmd("project-todo"),
    projectId: PROJECT_TODO,
    title: "todo-cli",
    workspaceRoot: project3Dir,
    defaultModel: "gpt-5-codex",
    createdAt: isoDaysAgo(2),
  });

  // 2. Chat threads with one realistic turn each. After dispatching
  //    `thread.turn.start`, we close out the turn with the assistant message
  //    and a `thread.turn.diff.complete` so the reactor on next desktop boot
  //    will not see any pending turn to resume (which would otherwise try to
  //    spin up a real provider session and surface auth flows).
  for (const chat of DEMO_CHATS) {
    const interactionMode = chat.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE;
    yield* engine.dispatch({
      type: "thread.create",
      commandId: cmd(`thread-create-${chat.threadId}`),
      threadId: chat.threadId,
      projectId: chat.projectId,
      title: chat.title,
      model: chat.model,
      runtimeMode: "approval-required",
      interactionMode,
      branch: null,
      worktreePath: chat.worktreePath,
      createdAt: chat.createdAt,
    });

    const turnId = TurnId.makeUnsafe(`turn-${chat.threadId}`);
    const userMessageId = MessageId.makeUnsafe(`msg-user-${chat.threadId}`);
    const assistantMessageId = MessageId.makeUnsafe(`msg-assistant-${chat.threadId}`);

    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: cmd(`turn-start-${chat.threadId}`),
      threadId: chat.threadId,
      message: {
        messageId: userMessageId,
        role: "user",
        text: chat.userMessage,
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode,
      createdAt: chat.createdAt,
    });

    // Session set with status="running" + activeTurnId=turnId promotes the
    // pending turn (created above by `thread.turn.start`) into a real running
    // turn keyed on `turnId`. Without this, the projection layer would carry
    // a phantom "pending" turn row alongside the completed one, which the
    // desktop renders as a never-ending "thinking…" spinner.
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: cmd(`session-running-${chat.threadId}`),
      threadId: chat.threadId,
      session: {
        threadId: chat.threadId,
        status: "running",
        providerName: chat.model,
        runtimeMode: "approval-required",
        activeTurnId: turnId,
        lastError: null,
        updatedAt: chat.createdAt,
      },
      createdAt: chat.createdAt,
    });

    yield* engine.dispatch({
      type: "thread.message.assistant.delta",
      commandId: cmd(`assistant-delta-${chat.threadId}`),
      threadId: chat.threadId,
      messageId: assistantMessageId,
      delta: chat.assistantMessage,
      turnId,
      createdAt: chat.createdAt,
    });

    // Optional: a TaskItem checklist (the chat-level todo list the assistant
    // maintains as it works). Renders as a small task tracker in the timeline.
    if (chat.tasks && chat.tasks.length > 0) {
      yield* engine.dispatch({
        type: "thread.tasks.update",
        commandId: cmd(`tasks-${chat.threadId}`),
        threadId: chat.threadId,
        tasks: chat.tasks,
        turnId,
        createdAt: chat.createdAt,
      });
    }

    // Optional: command-execution transcripts (e.g. a `cargo test` run with
    // its stdout). Each transcript fires the lifecycle the runtime layer
    // would: an initial `record` (status=running), one or more output chunks,
    // then a final `record` (status=completed, with exitCode).
    for (const transcript of chat.commandTranscripts ?? []) {
      const executionId = OrchestrationCommandExecutionId.makeUnsafe(transcript.id);
      yield* engine.dispatch({
        type: "thread.command-execution.record",
        commandId: cmd(`exec-start-${transcript.id}`),
        threadId: chat.threadId,
        commandExecution: {
          id: executionId,
          turnId,
          providerItemId: null,
          command: transcript.command,
          cwd: transcript.cwd,
          title: transcript.title,
          status: "running",
          detail: null,
          exitCode: null,
          startedAt: transcript.startedAt,
          completedAt: null,
          updatedAt: transcript.startedAt,
        },
        createdAt: transcript.startedAt,
      });
      for (let i = 0; i < transcript.chunks.length; i++) {
        const chunk = transcript.chunks[i] ?? "";
        yield* engine.dispatch({
          type: "thread.command-execution.output.append",
          commandId: cmd(`exec-out-${transcript.id}-${i}`),
          threadId: chat.threadId,
          commandExecutionId: executionId,
          chunk,
          updatedAt: transcript.completedAt,
          createdAt: transcript.completedAt,
        });
      }
      // For an in-progress chat we leave the transcript in `running` state
      // (no second `record` event with a final status) — the desktop renders
      // the live-streaming command-output UI.
      if (!chat.inProgress) {
        yield* engine.dispatch({
          type: "thread.command-execution.record",
          commandId: cmd(`exec-complete-${transcript.id}`),
          threadId: chat.threadId,
          commandExecution: {
            id: executionId,
            turnId,
            providerItemId: null,
            command: transcript.command,
            cwd: transcript.cwd,
            title: transcript.title,
            status: transcript.status,
            detail: null,
            exitCode: transcript.exitCode,
            startedAt: transcript.startedAt,
            completedAt: transcript.completedAt,
            updatedAt: transcript.completedAt,
          },
          createdAt: transcript.completedAt,
        });
      }
    }

    // Optional: file-change records, each carrying a unified-diff `patch` so
    // the desktop renders the inline FileDiff component with the actual diff
    // hunks visible. Two events per change:
    //
    //   1. `thread.file-change.record` — populates the file-change projection
    //      (visible in the turn header's "changed files" tree).
    //   2. `thread.activity.append` (kind=tool.completed, itemType=file_change,
    //      with matching fileChangeId) — surfaces the inline "File change"
    //      card in the chat timeline with the "Hide diff" toggle, which is
    //      what `apps/web/src/session-logic.ts::deriveWorkLogEntries` looks
    //      for. Without this activity, the diff exists in the projection but
    //      no card renders inline next to the assistant message.
    for (const fileChange of chat.fileChanges ?? []) {
      const fileChangeId = OrchestrationFileChangeId.makeUnsafe(fileChange.id);
      yield* engine.dispatch({
        type: "thread.file-change.record",
        commandId: cmd(`file-change-${fileChange.id}`),
        threadId: chat.threadId,
        fileChange: {
          id: fileChangeId,
          turnId,
          providerItemId: null,
          title: fileChange.title,
          detail: fileChange.detail,
          status: "completed",
          changedFiles: fileChange.changedFiles,
          startedAt: fileChange.startedAt,
          completedAt: fileChange.completedAt,
          updatedAt: fileChange.completedAt,
          patch: fileChange.patch,
        },
        createdAt: fileChange.completedAt,
      });
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: cmd(`file-change-activity-${fileChange.id}`),
        threadId: chat.threadId,
        activity: {
          id: EventId.makeUnsafe(`activity-${fileChange.id}`),
          tone: "tool",
          kind: "tool.completed",
          summary: fileChange.title,
          payload: {
            itemType: "file_change",
            status: "completed",
            title: fileChange.title,
            changedFiles: fileChange.changedFiles,
            fileChangeId: fileChange.id,
          },
          turnId,
          createdAt: fileChange.completedAt,
        },
        createdAt: fileChange.completedAt,
      });
    }

    // For in-progress chats we deliberately skip both `assistant.complete`
    // and `turn.diff.complete`. The turn stays open, the assistant message
    // stays unfinished, and the session row carries `status: "running"`
    // afterwards — together driving the "thinking..." typing indicator.
    if (!chat.inProgress) {
      yield* engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: cmd(`assistant-complete-${chat.threadId}`),
        threadId: chat.threadId,
        messageId: assistantMessageId,
        turnId,
        createdAt: chat.turnCompletedAt,
      });

      // Carry the file-change metadata (path, kind, additions, deletions) onto
      // the checkpoint summary so the turn header shows the changed-files tree.
      const checkpointFiles: ReadonlyArray<OrchestrationCheckpointFile> = (
        chat.fileChanges ?? []
      ).map((change) => change.checkpointFile);

      yield* engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: cmd(`turn-diff-complete-${chat.threadId}`),
        threadId: chat.threadId,
        turnId,
        completedAt: chat.turnCompletedAt,
        checkpointRef: CheckpointRef.makeUnsafe(`demo-checkpoint-${chat.threadId}`),
        status: "ready",
        files: checkpointFiles,
        assistantMessageId,
        checkpointTurnCount: 1,
        createdAt: chat.turnCompletedAt,
      });
    }

    // Optional: a proposed plan attached to this turn. Surfaces the
    // "plan ready — accept or revise" affordance in the desktop UI.
    if (chat.proposedPlan) {
      yield* engine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: cmd(`plan-upsert-${chat.threadId}`),
        threadId: chat.threadId,
        proposedPlan: {
          id: chat.proposedPlan.id,
          turnId,
          planMarkdown: chat.proposedPlan.planMarkdown,
          implementedAt: null,
          implementationThreadId: null,
          createdAt: chat.proposedPlan.upsertedAt,
          updatedAt: chat.proposedPlan.upsertedAt,
        },
        createdAt: chat.proposedPlan.upsertedAt,
      });
    }

    // Final session state. Defaults to `ready` (idle) so the desktop never
    // shows a "session running" badge. Overridable per-chat:
    //   - `finalSessionStatus: "interrupted"` → "user stopped me" surface
    //   - `inProgress: true` → keep `status: "running"` with active turn id,
    //     surfacing the typing indicator and live-output UI
    const finalStatus: "ready" | "interrupted" | "running" = chat.inProgress
      ? "running"
      : (chat.finalSessionStatus ?? "ready");
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: cmd(`session-final-${chat.threadId}`),
      threadId: chat.threadId,
      session: {
        threadId: chat.threadId,
        status: finalStatus,
        providerName: chat.model,
        runtimeMode: "approval-required",
        activeTurnId: chat.inProgress ? turnId : null,
        lastError:
          finalStatus === "interrupted" ? "Interrupted by user before the turn completed." : null,
        updatedAt: chat.turnCompletedAt,
      },
      createdAt: chat.turnCompletedAt,
    });
  }

  // 3. Planning workflow — create the three supporting threads, then create
  //    the workflow, then upsert the rich state we want screenshotted.
  yield* engine.dispatch({
    type: "thread.create",
    commandId: cmd("planning-author-a"),
    threadId: THREAD_RSS_AUTHOR_A,
    projectId: PROJECT_RSS,
    title: "Plan A — Parallelize feed refresh",
    model: "claude-sonnet-4-5",
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: project2Dir,
    createdAt: isoHoursAgo(3),
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: cmd("planning-author-b"),
    threadId: THREAD_RSS_AUTHOR_B,
    projectId: PROJECT_RSS,
    title: "Plan B — Parallelize feed refresh",
    model: "gpt-5-codex",
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: project2Dir,
    createdAt: isoHoursAgo(3),
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: cmd("planning-merge"),
    threadId: THREAD_RSS_MERGE,
    projectId: PROJECT_RSS,
    title: "Merge — Parallelize feed refresh",
    model: "claude-opus-4",
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: project2Dir,
    createdAt: isoHoursAgo(3),
  });
  // Implementation phase: an implementer thread plus two code-review threads.
  // Required so the workflow's `implementation` block can reference real
  // threadIds when it's upserted in the "completed" happy-path state.
  yield* engine.dispatch({
    type: "thread.create",
    commandId: cmd("planning-implementation"),
    threadId: THREAD_RSS_IMPLEMENTATION,
    projectId: PROJECT_RSS,
    title: "Implementation — Parallelize feed refresh",
    model: "claude-sonnet-4-5",
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: "feat/parallel-feed-refresh",
    worktreePath: project2Dir,
    createdAt: isoMinutesAgo(70),
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: cmd("planning-impl-reviewer-a"),
    threadId: THREAD_RSS_IMPL_REVIEWER_A,
    projectId: PROJECT_RSS,
    title: "Code review (Claude) — Parallelize feed refresh",
    model: "claude-sonnet-4-5",
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: "feat/parallel-feed-refresh",
    worktreePath: project2Dir,
    createdAt: isoMinutesAgo(45),
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: cmd("planning-impl-reviewer-b"),
    threadId: THREAD_RSS_IMPL_REVIEWER_B,
    projectId: PROJECT_RSS,
    title: "Code review (Codex) — Parallelize feed refresh",
    model: "gpt-5-codex",
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: "feat/parallel-feed-refresh",
    worktreePath: project2Dir,
    createdAt: isoMinutesAgo(45),
  });

  yield* engine.dispatch({
    type: "project.workflow.create",
    commandId: cmd("planning-create"),
    workflowId: PLANNING_WORKFLOW_ID,
    projectId: PROJECT_RSS,
    title: PLANNING_WORKFLOW.title,
    slug: PLANNING_WORKFLOW.slug,
    requirementPrompt: PLANNING_WORKFLOW.requirementPrompt,
    plansDirectory: PLANNING_WORKFLOW.plansDirectory,
    authorThreadIdA: THREAD_RSS_AUTHOR_A,
    authorThreadIdB: THREAD_RSS_AUTHOR_B,
    selfReviewEnabled: true,
    branchA: PLANNING_WORKFLOW.branchA.authorSlot,
    branchB: PLANNING_WORKFLOW.branchB.authorSlot,
    merge: PLANNING_WORKFLOW.merge.mergeSlot,
    createdAt: PLANNING_WORKFLOW.createdAt,
  });
  yield* engine.dispatch({
    type: "project.workflow.upsert",
    commandId: cmd("planning-upsert"),
    projectId: PROJECT_RSS,
    workflow: PLANNING_WORKFLOW,
    createdAt: PLANNING_WORKFLOW.updatedAt,
  });

  // 4. Code review workflow.
  yield* engine.dispatch({
    type: "thread.create",
    commandId: cmd("review-reviewer-a"),
    threadId: THREAD_TODO_REVIEWER_A,
    projectId: PROJECT_TODO,
    title: "Reviewer A — Kanban board view",
    model: "claude-sonnet-4-5",
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: "feat/kanban-view",
    worktreePath: project3Dir,
    createdAt: isoHoursAgo(1),
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: cmd("review-reviewer-b"),
    threadId: THREAD_TODO_REVIEWER_B,
    projectId: PROJECT_TODO,
    title: "Reviewer B — Kanban board view",
    model: "gpt-5-codex",
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: "feat/kanban-view",
    worktreePath: project3Dir,
    createdAt: isoHoursAgo(1),
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: cmd("review-consolidation"),
    threadId: THREAD_TODO_CONSOLIDATION,
    projectId: PROJECT_TODO,
    title: "Consolidation — Kanban board view",
    model: "claude-opus-4",
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: "feat/kanban-view",
    worktreePath: project3Dir,
    createdAt: isoHoursAgo(1),
  });

  yield* engine.dispatch({
    type: "project.code-review-workflow.create",
    commandId: cmd("review-create"),
    workflowId: CODE_REVIEW_WORKFLOW_ID,
    projectId: PROJECT_TODO,
    title: CODE_REVIEW_WORKFLOW.title,
    slug: CODE_REVIEW_WORKFLOW.slug,
    reviewPrompt: CODE_REVIEW_WORKFLOW.reviewPrompt,
    branch: CODE_REVIEW_WORKFLOW.branch,
    reviewerA: CODE_REVIEW_WORKFLOW.reviewerA.slot,
    reviewerB: CODE_REVIEW_WORKFLOW.reviewerB.slot,
    consolidation: CODE_REVIEW_WORKFLOW.consolidation.slot,
    reviewerThreadIdA: THREAD_TODO_REVIEWER_A,
    reviewerThreadIdB: THREAD_TODO_REVIEWER_B,
    createdAt: CODE_REVIEW_WORKFLOW.createdAt,
  });
  yield* engine.dispatch({
    type: "project.code-review-workflow.upsert",
    commandId: cmd("review-upsert"),
    projectId: PROJECT_TODO,
    workflow: CODE_REVIEW_WORKFLOW,
    updatedAt: CODE_REVIEW_WORKFLOW.updatedAt,
  });

  yield* Effect.log("[seed-demo] dispatched all commands successfully");
});

// ---------------------------------------------------------------------------
// Layer wiring — minimal subset of the integration harness that excludes the
// reactor, providers, telemetry, and websocket layers. The seed only needs to
// append events and let the projection pipeline build the read model.
// ---------------------------------------------------------------------------

const dbPath = Path.join(normalized, "state.sqlite");

const persistenceLayer = makeSqlitePersistenceLive(dbPath);
const orchestrationLayer = OrchestrationEngineLive.pipe(
  Layer.provide(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(OrchestrationProjectionPipelineLive),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
);

const layer = orchestrationLayer.pipe(
  Layer.provide(persistenceLayer),
  Layer.provideMerge(ServerConfig.layerTest(workspacesDir, normalized)),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(Logger.layer([Logger.consolePretty()])),
);

const runtime = ManagedRuntime.make(layer);
try {
  await runtime.runPromise(seedProgram);
  console.log(`[seed-demo] OK — database written to ${dbPath}`);
} catch (error) {
  console.error("[seed-demo] FAILED:", error);
  process.exitCode = 1;
} finally {
  await runtime.dispose();
}
