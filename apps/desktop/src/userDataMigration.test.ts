import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { migrateUserData } from "./userDataMigration";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "f5-import-"));
  roots.push(root);
  const legacy = join(root, "T3 Code (Alpha)");
  fs.mkdirSync(legacy);
  fs.writeFileSync(join(legacy, "settings"), "original");
  const options = {
    appDataBase: root,
    targetName: "f5",
    legacyNames: ["T3 Code (Alpha)", "t3code"],
    skipImport: false,
    platform: "darwin" as const,
    hostname: hostname(),
  };
  return { root, legacy, options, target: join(root, "f5") };
}
describe("userData import", () => {
  it("preserves an existing target", () => {
    const { target, options } = fixture();
    fs.mkdirSync(target);
    fs.writeFileSync(join(target, "existing"), "keep");
    expect(migrateUserData(options).kind).toBe("ready");
    expect(fs.existsSync(join(target, "settings"))).toBe(false);
  });
  it("copies the first legacy source, excludes nested caches, and writes a marker", () => {
    const { root, legacy, options, target } = fixture();
    fs.mkdirSync(join(root, "t3code"));
    fs.writeFileSync(join(root, "t3code", "wrong"), "wrong");
    fs.mkdirSync(join(legacy, "Partitions/x/Cache"), { recursive: true });
    fs.writeFileSync(join(legacy, "Partitions/x/Cache/cache"), "cache");
    fs.mkdirSync(`${target}.migrating-old`);
    expect(migrateUserData(options)).toEqual({ kind: "ready", path: target, migratedFrom: legacy });
    expect(fs.readFileSync(join(target, "settings"), "utf8")).toBe("original");
    expect(fs.readFileSync(join(target, ".f5-migrated-from"), "utf8")).toBe(legacy);
    expect(fs.existsSync(join(target, "Partitions/x/Cache"))).toBe(false);
    expect(fs.existsSync(`${target}.migrating-old`)).toBe(false);
    expect(fs.readdirSync(legacy).sort()).toEqual(["Partitions", "settings"]);
  });
  it("blocks a live legacy singleton, then imports after it exits", () => {
    const { options, legacy } = fixture();
    fs.symlinkSync(`${hostname()}-${process.pid}`, join(legacy, "SingletonLock"));
    expect(migrateUserData(options).kind).toBe("blocked");
    fs.unlinkSync(join(legacy, "SingletonLock"));
    fs.symlinkSync(`${hostname()}-2147483647`, join(legacy, "SingletonLock"));
    expect(migrateUserData(options).kind).toBe("ready");
  });
  it("blocks low space and copy failures without leaving a target", () => {
    const { options, target, root } = fixture();
    expect(
      migrateUserData({
        ...options,
        statfs: (() => ({ bavail: 0, bsize: 4096 })) as unknown as typeof fs.statfsSync,
      }).kind,
    ).toBe("blocked");
    expect(
      migrateUserData({
        ...options,
        copy: () => {
          throw new Error("disk error");
        },
      }).kind,
    ).toBe("blocked");
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(root)).toEqual(["T3 Code (Alpha)"]);
  });
  it("reclaims a stale lock and supports skipping", () => {
    const { options, target } = fixture();
    fs.writeFileSync(`${target}.migration.lock`, "2147483647");
    expect(migrateUserData({ ...options, skipImport: true }).kind).toBe("ready");
    expect(fs.readFileSync(join(target, ".f5-migrated-from"), "utf8")).toBe("skipped");
    expect(fs.existsSync(join(target, "settings"))).toBe(false);
  });
  it("creates an empty profile when no legacy source exists", () => {
    const { options, legacy, target } = fixture();
    fs.rmSync(legacy, { recursive: true });
    expect(migrateUserData(options).kind).toBe("ready");
    expect(fs.readdirSync(target)).toEqual([]);
  });
});

it.each(["", "not a pid", '{"pid":null}'])(
  "reclaims abandoned incomplete lock %j including skip-import",
  (contents) => {
    const { options, target } = fixture();
    const lock = `${target}.migration.lock`;
    fs.writeFileSync(lock, contents);
    fs.utimesSync(lock, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
    expect(migrateUserData({ ...options, skipImport: true }).kind).toBe("ready");
    expect(fs.readFileSync(join(target, ".f5-migrated-from"), "utf8")).toBe("skipped");
  },
);
it("does not reclaim an incomplete record a live writer may still be publishing", () => {
  const { options, target } = fixture();
  fs.writeFileSync(`${target}.migration.lock`, "");
  expect(migrateUserData({ ...options, lockWaitMs: 0 }).kind).toBe("blocked");
});
it("never expires a live owner in the current boot solely because its copy is old", () => {
  const { options, target } = fixture();
  const now = Date.now();
  fs.writeFileSync(`${target}.migration.lock`, String(process.pid));
  fs.utimesSync(`${target}.migration.lock`, new Date(now - 120_000), new Date(now - 120_000));
  expect(
    migrateUserData({ ...options, now: () => now, uptimeSeconds: () => 3600, lockWaitMs: 0 }).kind,
  ).toBe("blocked");
});
it("reclaims a pre-reboot PID even when it has been reused by a live process", () => {
  const { options, target } = fixture();
  const now = Date.now();
  fs.writeFileSync(`${target}.migration.lock`, String(process.pid));
  fs.utimesSync(`${target}.migration.lock`, new Date(now - 120_000), new Date(now - 120_000));
  expect(migrateUserData({ ...options, now: () => now, uptimeSeconds: () => 60 }).kind).toBe(
    "ready",
  );
});
it("imports into a directory Electron pre-created empty", () => {
  const { options, target } = fixture();
  fs.mkdirSync(target);
  expect(migrateUserData(options).kind).toBe("ready");
  expect(fs.readFileSync(join(target, "settings"), "utf8")).toBe("original");
});
it("imports when the pre-created target holds only OS metadata", () => {
  const { options, target } = fixture();
  fs.mkdirSync(target);
  fs.writeFileSync(join(target, ".DS_Store"), "finder");
  expect(migrateUserData(options).kind).toBe("ready");
  expect(fs.readFileSync(join(target, "settings"), "utf8")).toBe("original");
});
it("excludes partition service-worker caches and blobs from copying and disk sizing", () => {
  const { options, legacy, target } = fixture();
  for (const path of [
    "Partitions/x/Service Worker/CacheStorage",
    "Partitions/x/Service Worker/ScriptCache",
    "Partitions/x/blob_storage",
  ]) {
    fs.mkdirSync(join(legacy, path), { recursive: true });
    fs.writeFileSync(join(legacy, path, "cached"), Buffer.alloc(1024));
  }
  expect(migrateUserData(options).kind).toBe("ready");
  expect(fs.existsSync(join(target, "Partitions/x/blob_storage"))).toBe(false);
  expect(fs.existsSync(join(target, "Partitions/x/Service Worker/CacheStorage"))).toBe(false);
});
