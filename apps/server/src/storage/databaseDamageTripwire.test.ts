import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { Writable } from "node:stream";

import type { DatabaseDamage } from "@t3tools/contracts";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";

import {
  getDatabaseDamage,
  loadPersistedDatabaseDamage,
  reportDatabaseCorruption,
  resetDatabaseHealthForTest,
} from "../persistence/databaseHealth.ts";
import { startDatabaseDamageTripwire, writeJsonStreamed } from "./databaseDamageTripwire.ts";

const roots: string[] = [];
afterEach(() => {
  resetDatabaseHealthForTest();
  for (const root of roots.splice(0)) FS.rmSync(root, { recursive: true, force: true });
});

const until = (condition: () => boolean) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        const poll = () => (condition() ? resolve() : setTimeout(poll, 5));
        poll();
      }),
  );

/** A stream that applies backpressure immediately and then fails like a full disk. */
const failingStream = () =>
  new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      setTimeout(
        () => callback(Object.assign(new Error("no space left on device"), { code: "ENOSPC" })),
        1,
      );
    },
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

it("rejects instead of crashing when the stream fails while waiting for drain", async () => {
  const model = { threads: Array.from({ length: 50 }, (_, index) => ({ id: `t${index}` })) };
  await expect(writeJsonStreamed("/unused", model, failingStream)).rejects.toThrow(
    /no space left/u,
  );
});

it("publishes a recovery error after every retry fails", async () => {
  const stateDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-tripwire-fail-"));
  roots.push(stateDir);
  const published: DatabaseDamage[] = [];
  let attempts = 0;

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* startDatabaseDamageTripwire({
          stateDir,
          getReadModel: Effect.succeed({ threads: [{ id: "thread-1" }] }),
          publish: (damage) => Effect.sync(() => void published.push(damage)),
          openStream: () => {
            attempts += 1;
            return failingStream();
          },
          retryDelay: "1 millis",
        });
        reportDatabaseCorruption(Path.join(stateDir, "state.sqlite"), corrupt());
        yield* until(() => getDatabaseDamage()?.recoveryError != null);
      }),
    ),
  );

  expect(attempts).toBe(3);
  expect(getDatabaseDamage()?.recoveryFile).toBeNull();
  expect(published.at(-1)?.recoveryError).toMatch(/no space left/u);
  expect(FS.readdirSync(Path.join(stateDir, "recovery"))).toEqual([]);
});

it("keeps damage across restarts until the database file is replaced", () => {
  const stateDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-damage-marker-"));
  roots.push(stateDir);
  const dbPath = Path.join(stateDir, "state.sqlite");
  FS.writeFileSync(dbPath, "damaged pages");

  reportDatabaseCorruption(dbPath, corrupt());
  const markerPath = `${dbPath}.damaged`;
  expect(FS.existsSync(markerPath)).toBe(true);
  expect(getDatabaseDamage()).toMatchObject({ fromPreviousRun: false, markerPath });

  resetDatabaseHealthForTest();
  expect(loadPersistedDatabaseDamage(dbPath)).toBe("loaded");
  expect(getDatabaseDamage()).toMatchObject({ errorCode: 11, fromPreviousRun: true, markerPath });

  // A restore moves a different file into place.
  resetDatabaseHealthForTest();
  FS.writeFileSync(`${dbPath}.restored`, "restored");
  FS.renameSync(`${dbPath}.restored`, dbPath);
  expect(loadPersistedDatabaseDamage(dbPath)).toBe("cleared");
  expect(getDatabaseDamage()).toBeNull();
  expect(FS.existsSync(markerPath)).toBe(false);
  expect(loadPersistedDatabaseDamage(dbPath)).toBe("none");
});

it("does not write another recovery copy for damage carried over from an earlier run", async () => {
  const stateDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-tripwire-carried-"));
  roots.push(stateDir);
  const dbPath = Path.join(stateDir, "state.sqlite");
  FS.writeFileSync(dbPath, "damaged pages");
  reportDatabaseCorruption(dbPath, corrupt());
  resetDatabaseHealthForTest();
  loadPersistedDatabaseDamage(dbPath);
  const published: DatabaseDamage[] = [];
  let reads = 0;

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* startDatabaseDamageTripwire({
          stateDir,
          getReadModel: Effect.sync(() => {
            reads += 1;
            return {};
          }),
          publish: (damage) => Effect.sync(() => void published.push(damage)),
        });
        yield* until(() => published.length > 0);
        yield* Effect.sleep("20 millis");
      }),
    ),
  );

  expect(reads).toBe(0);
  expect(published[0]?.fromPreviousRun).toBe(true);
  expect(FS.existsSync(Path.join(stateDir, "recovery"))).toBe(false);
});
