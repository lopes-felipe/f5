import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { atomicJson, readJson } from "./files";
import { cliTarget } from "@t3tools/shared/cliRelease";
import { performHandoff, recoverHandoff, snapshotDatabase } from "./handoff";
let root: string, database: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "f5-handoff-test-"));
  database = path.join(root, "state.sqlite");
  await atomicJson(path.join(root, "current.json"), {
    schemaVersion: 1,
    version: "1.0.0",
    target: cliTarget(),
  });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const request = () => ({ schemaVersion: 1 as const, id: randomUUID(), version: "2.0.0" });
describe("staged server update", () => {
  it("commits before releasing activation and correlates the outcome", async () => {
    await fs.writeFile(database, "old");
    const update = request();
    const order: string[] = [];
    const result = await performHandoff(root, database, update, {
      preflight: async () => {
        order.push("preflight");
      },
      stopOld: async () => {
        order.push("stop");
      },
      trial: () => ({
        prepared: Promise.resolve(),
        activated: Promise.resolve(),
        stop: async () => {},
        activate: async () => {
          expect(await readJson(path.join(root, "current.json"))).toMatchObject({
            version: "2.0.0",
          });
          expect(await readJson(path.join(root, "outcome.json"))).toMatchObject({
            id: update.id,
            outcome: "committed",
          });
          order.push("activate");
        },
      }),
      restart: async () => {
        throw new Error("unexpected restart");
      },
    });
    expect(order).toEqual(["preflight", "stop", "activate"]);
    expect(result).toMatchObject({ id: update.id, outcome: "committed" });
  });
  it("restores SQLite main/WAL/SHM after a failed migration before restarting the old version", async () => {
    const initial = new DatabaseSync(database);
    initial.exec("CREATE TABLE original (id INTEGER); INSERT INTO original VALUES (7)");
    initial.close();
    await fs.writeFile(database + "-wal", "old-wal");
    await fs.writeFile(database + "-shm", "old-shm");
    const original = await fs.readFile(database);
    const events: string[] = [];
    const result = await performHandoff(root, database, request(), {
      preflight: async () => {},
      stopOld: async () => {},
      trial: () => ({
        prepared: (async () => {
          await fs.writeFile(database, "bad migration");
          await fs.writeFile(database + "-wal", "new-wal");
          await fs.rm(database + "-shm");
          throw new Error("migration failed");
        })(),
        activated: Promise.resolve(),
        activate: async () => {},
        stop: async () => {
          events.push("trial stopped");
        },
      }),
      restart: async (version, outcome) => {
        expect(version).toBe("1.0.0");
        expect(outcome.outcome).toBe("rolled-back");
        expect(await fs.readFile(database)).toEqual(original);
        expect(await fs.readFile(database + "-wal", "utf8")).toBe("old-wal");
        expect(await fs.readFile(database + "-shm", "utf8")).toBe("old-shm");
        events.push("old restarted");
      },
    });
    expect(result.outcome).toBe("rolled-back");
    expect(events).toEqual(["trial stopped", "old restarted"]);
  });
  it("does not stop a healthy server when architecture/launcher preflight fails", async () => {
    let stopped = false;
    await expect(
      performHandoff(root, database, request(), {
        preflight: async () => {
          throw new Error("wrong architecture");
        },
        stopOld: async () => {
          stopped = true;
        },
        trial: () => {
          throw new Error("unexpected trial");
        },
        restart: async () => {},
      }),
    ).rejects.toThrow("wrong architecture");
    expect(stopped).toBe(false);
  });
  it.each(["trial", "restoring"])(
    "recovers an interrupted %s handoff repeatedly before any server starts",
    async (phase) => {
      const update = request();
      await fs.writeFile(database, "old");
      await snapshotDatabase(database, path.join(root, "db-backup", update.id));
      await fs.writeFile(database, "trial");
      await fs.writeFile(database + "-wal", "trial-wal");
      await atomicJson(path.join(root, "handoff.json"), { ...update, previous: "1.0.0", phase });
      const result = await recoverHandoff(root, database);
      expect(result).toMatchObject({ id: update.id, outcome: "rolled-back", version: "1.0.0" });
      expect(await fs.readFile(database, "utf8")).toBe("old");
      await expect(fs.access(database + "-wal")).rejects.toThrow();
      expect(await recoverHandoff(root, database)).toBeUndefined();
    },
  );
  it("rolls forward a durable commit after launcher interruption", async () => {
    const update = request();
    await fs.writeFile(database, "migrated");
    await atomicJson(path.join(root, "handoff.json"), {
      ...update,
      previous: "1.0.0",
      phase: "committed",
    });
    expect(await recoverHandoff(root, database)).toMatchObject({
      id: update.id,
      outcome: "committed",
      version: "2.0.0",
    });
    expect(await fs.readFile(database, "utf8")).toBe("migrated");
  });
  it("fails closed if the rollback snapshot is incomplete", async () => {
    const update = request();
    await fs.writeFile(database, "trial");
    await atomicJson(path.join(root, "handoff.json"), {
      ...update,
      previous: "1.0.0",
      phase: "trial",
    });
    await expect(recoverHandoff(root, database)).rejects.toThrow();
    expect(await fs.readFile(database, "utf8")).toBe("trial");
    expect(await readJson(path.join(root, "handoff.json"))).toMatchObject({ phase: "restoring" });
  });
});

it("rejects a downgrade before touching launcher or database state", async () => {
  const { requestUpdate } = await import("./handoff");
  await expect(requestUpdate(root, "0.9.0")).rejects.toThrow("newer version");
  await expect(fs.access(path.join(root, "pending.json"))).rejects.toThrow();
});

it("retains a correlated outcome across later launcher restarts", async () => {
  const { readUpdateOutcome } = await import("./handoff");
  const outcome = { id: randomUUID(), outcome: "committed", version: "2.0.0" };
  await atomicJson(path.join(root, "outcome.json"), outcome);
  expect(await recoverHandoff(root, database)).toBeUndefined();
  expect(await readUpdateOutcome(root)).toEqual(outcome);
});
