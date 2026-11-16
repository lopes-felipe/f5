import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import { assertDatabaseFileUsable, inspectDatabaseHeader } from "./databaseFiles.ts";
import {
  corruptionErrorCode,
  getDatabaseDamage,
  resetDatabaseHealthForTest,
} from "./databaseHealth.ts";
import { makeRuntimeSqliteLayer, makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";

const roots: string[] = [];
afterEach(() => {
  resetDatabaseHealthForTest();
  for (const root of roots.splice(0)) FS.rmSync(root, { recursive: true, force: true });
});

function tempStateDir() {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-db-files-"));
  roots.push(root);
  return root;
}

describe("assertDatabaseFileUsable", () => {
  it("accepts missing, empty and valid databases", () => {
    const stateDir = tempStateDir();
    const dbPath = Path.join(stateDir, "state.sqlite");
    expect(() => assertDatabaseFileUsable(dbPath)).not.toThrow();
    FS.writeFileSync(dbPath, "");
    expect(() => assertDatabaseFileUsable(dbPath)).not.toThrow();
    FS.rmSync(dbPath);
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE t (x)");
    db.close();
    expect(inspectDatabaseHeader(dbPath).status).toBe("valid");
    expect(() => assertDatabaseFileUsable(dbPath)).not.toThrow();
  });

  it("refuses a file overwritten with test output and names the newest snapshot", () => {
    const stateDir = tempStateDir();
    const dbPath = Path.join(stateDir, "state.sqlite");
    FS.writeFileSync(dbPath, "ready");
    for (const name of ["snapshot-1790000000000", "snapshot-1790000360000"]) {
      FS.mkdirSync(Path.join(stateDir, "backups", name), { recursive: true });
      FS.writeFileSync(Path.join(stateDir, "backups", name, "state.sqlite"), "copy");
    }
    // Newer, but emptied by storage cleanup: not a copy anyone can restore.
    FS.mkdirSync(Path.join(stateDir, "backups", "snapshot-1790000720000"));
    expect(() => assertDatabaseFileUsable(dbPath)).toThrow(
      /damaged \(missing the SQLite file header; 5 bytes\).*snapshot-1790000360000/su,
    );
  });

  it("keeps startup from initializing over the damaged file", async () => {
    const stateDir = tempStateDir();
    const dbPath = Path.join(stateDir, "state.sqlite");
    FS.writeFileSync(dbPath, "ready");
    const runtime = ManagedRuntime.make(
      makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer)),
    );
    try {
      const exit = await runtime.runPromiseExit(Effect.service(SqlClient.SqlClient));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(exit)).toMatch(/will not open or replace it/u);
    } finally {
      await runtime.dispose();
    }
    expect(FS.readFileSync(dbPath, "utf8")).toBe("ready");
  });
});

describe("databaseHealth", () => {
  it("recognizes primary and extended corruption codes only", () => {
    expect(corruptionErrorCode({ errcode: 11 })).toBe(11);
    expect(corruptionErrorCode({ errcode: 26 })).toBe(26);
    expect(corruptionErrorCode({ errcode: 267 })).toBe(11);
    expect(corruptionErrorCode({ errcode: 5 })).toBeNull();
    expect(corruptionErrorCode(new Error("plain"))).toBeNull();
  });

  it("records corruption reported by the SQLite client", async () => {
    const stateDir = tempStateDir();
    const dbPath = Path.join(stateDir, "state.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE t (x)");
    db.close();
    const runtime = ManagedRuntime.make(makeRuntimeSqliteLayer({ filename: dbPath }));
    try {
      await runtime.runPromise(Effect.service(SqlClient.SqlClient));
      // Destroy the file the open connection is using, as the test run did.
      FS.writeFileSync(dbPath, "ready");
      await runtime.runPromiseExit(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`SELECT * FROM sqlite_master`;
        }),
      );
    } finally {
      await runtime.dispose();
    }
    expect(getDatabaseDamage()).toMatchObject({ databasePath: dbPath });
    expect([11, 26]).toContain(getDatabaseDamage()?.errorCode);
  });
});
