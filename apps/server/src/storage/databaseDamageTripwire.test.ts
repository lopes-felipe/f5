import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import type { DatabaseDamage } from "@t3tools/contracts";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";

import {
  getDatabaseDamage,
  reportDatabaseCorruption,
  resetDatabaseHealthForTest,
} from "../persistence/databaseHealth.ts";
import { startDatabaseDamageTripwire } from "./databaseDamageTripwire.ts";

const roots: string[] = [];
afterEach(() => {
  resetDatabaseHealthForTest();
  for (const root of roots.splice(0)) FS.rmSync(root, { recursive: true, force: true });
});

const corrupt = () => Object.assign(new Error("database disk image is malformed"), { errcode: 11 });

it("writes the in-memory read model once and publishes where it is", async () => {
  const stateDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-tripwire-"));
  roots.push(stateDir);
  FS.mkdirSync(Path.join(stateDir, "backups", "snapshot-1790000000000"), { recursive: true });
  const published: DatabaseDamage[] = [];
  const readModel = {
    snapshotSequence: 7,
    projects: [{ id: "project-1" }],
    threads: [{ id: "thread-1", messages: [{ id: "m1", text: "hello" }] }],
    updatedAt: "2026-11-02T10:00:00.000Z",
  };
  let reads = 0;

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* startDatabaseDamageTripwire({
          stateDir,
          getReadModel: Effect.sync(() => {
            reads += 1;
            return readModel;
          }),
          publish: (damage) => Effect.sync(() => void published.push(damage)),
          now: () => 1790000000123,
        });
        const dbPath = Path.join(stateDir, "state.sqlite");
        reportDatabaseCorruption(dbPath, corrupt());
        reportDatabaseCorruption(dbPath, corrupt());
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              const poll = () =>
                getDatabaseDamage()?.recoveryFile ? resolve() : setTimeout(poll, 5);
              poll();
            }),
        );
      }),
    ),
  );

  const recoveryFile = Path.join(stateDir, "recovery", "readmodel-1790000000123.json");
  expect(reads).toBe(1);
  expect(JSON.parse(FS.readFileSync(recoveryFile, "utf8"))).toEqual(readModel);
  expect(FS.readdirSync(Path.join(stateDir, "recovery"))).toEqual(["readmodel-1790000000123.json"]);
  expect(published.at(-1)).toMatchObject({
    errorCode: 11,
    recoveryFile,
    latestSnapshot: Path.join(stateDir, "backups", "snapshot-1790000000000"),
  });
  expect(published[0]?.recoveryFile).toBeNull();
});
