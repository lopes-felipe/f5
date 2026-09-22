import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import * as Net from "node:net";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { describe, it, expect } from "vitest";
import { Schema } from "effect";
import { ServerSettings, ProviderInstanceId, CodexSettings } from "@t3tools/contracts";
import { ProfileRegistryStore } from "./ProfileRegistryStore";
import { acquireInstanceLock } from "./InstanceLock";

async function fixture() {
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-profiles-"));
  return { root, store: new ProfileRegistryStore(Path.join(root, "state"), 4773) };
}

it("waits for a live writer and recovers its marker only after process death", async () => {
  const { root, store } = await fixture();
  await store.init();
  const directory = Path.join(store.root, "locks");
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    const fs = require('node:fs'); const path = require('node:path');
    const { DatabaseSync } = require('node:sqlite');
    const directory = process.argv[1];
    const db = new DatabaseSync(path.join(directory, 'registry.guard.lock.sqlite'));
    db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; UPDATE owner SET pid=' + process.pid + '; COMMIT');
    fs.writeFileSync(path.join(directory, 'registry.lock'), 'owned by live child');
    process.stdout.write('ready'); setInterval(() => {}, 1000);
  `,
      directory,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await once(child.stdout!, "data");
    let completed = false;
    const mutation = store.create({ name: "Recovered" }).then((record) => {
      completed = true;
      return record;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(completed).toBe(false);
    expect(await FS.readFile(Path.join(directory, "registry.lock"), "utf8")).toBe(
      "owned by live child",
    );
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    expect((await mutation).name).toBe("Recovered");
    expect(await FS.stat(Path.join(directory, "registry.lock")).catch(() => null)).toBeNull();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await FS.rm(root, { recursive: true, force: true });
  }
});

it("allocates past ports owned by unrelated programs", async () => {
  const listener = Net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-profile-port-"));
  try {
    const occupied = (listener.address() as Net.AddressInfo).port;
    const store = new ProfileRegistryStore(Path.join(root, "state"), occupied - 1);
    await store.init();
    await store.create({ name: "Reserved" });
    const work = await store.create({ name: "Work" });
    expect(work.port).toBeGreaterThan(occupied);
    expect(listener.listening).toBe(true);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await FS.rm(root, { recursive: true, force: true });
  }
});

it("drops stale incomplete provisioning while retaining recent reservations", async () => {
  const { root, store } = await fixture();
  try {
    await store.init();
    const stale = await store.create({ name: "Stale" });
    const recent = await store.create({ name: "Recent" });
    await FS.unlink(Path.join(store.root, stale.id, "settings.json"));
    await FS.unlink(Path.join(store.root, recent.id, "settings.json"));
    const registry = JSON.parse(await FS.readFile(store.path, "utf8"));
    for (const record of registry.profiles)
      if (!record.isDefault) {
        record.status = "provisioning";
        record.createdAt =
          record.id === stale.id
            ? new Date(Date.now() - 660000).toISOString()
            : new Date().toISOString();
      }
    await FS.writeFile(store.path, JSON.stringify(registry));
    await store.init();
    const records = (await store.list(stale.id)).profiles;
    expect(records.some((record) => record.id === stale.id)).toBe(false);
    expect(records.find((record) => record.id === recent.id)?.status).toBe("provisioning");
  } finally {
    await FS.rm(root, { recursive: true, force: true });
  }
});

it("never forgets retired origins after more than 32 removals", async () => {
  const { root, store } = await fixture();
  try {
    await store.init();
    const registry = JSON.parse(await FS.readFile(store.path, "utf8"));
    registry.retiredPorts = Array.from({ length: 35 }, (_, index) => store.portBase + index);
    await FS.writeFile(store.path, JSON.stringify(registry));
    const work = await store.create({ name: "Work" });
    expect(work.port).toBeGreaterThanOrEqual(store.portBase + 35);
    await store.remove(work.id);
    const persisted = JSON.parse(await FS.readFile(store.path, "utf8"));
    expect(persisted.retiredPorts).toContain(store.portBase);
    expect(persisted.retiredPorts).toHaveLength(36);
  } finally {
    await FS.rm(root, { recursive: true, force: true });
  }
});
describe("ProfileRegistryStore", () => {
  it("provisions independent state without touching default state, preserving future fields", async () => {
    const { root, store } = await fixture();
    try {
      const first = await store.init();
      expect(first.ok).toBe(true);
      expect(await FS.stat(store.defaultStateDir).catch(() => null)).toBeNull();
      expect(await store.init()).toEqual(first);
      const original = JSON.parse(await FS.readFile(store.path, "utf8"));
      original.future = { untouched: true };
      original.profiles[0].future = 42;
      await FS.writeFile(store.path, JSON.stringify(original));
      const [work, personal] = await Promise.all([
        store.create({ name: "Work" }),
        store.create({ name: "Work" }),
      ]);
      expect(work.port).not.toBe(personal.port);
      expect(work.slug).not.toBe(personal.slug);
      const dir = (await store.list(work.id)).profiles.find((p) => p.id === work.id)!.stateDir;
      const seed = Schema.decodeUnknownSync(ServerSettings)(
        JSON.parse(await FS.readFile(Path.join(dir, "settings.json"), "utf8")),
      );
      expect(
        Schema.decodeUnknownSync(CodexSettings)(
          seed.providerInstances[ProviderInstanceId.make("codex")]?.config ?? {},
        ).homePath,
      ).toBe(Path.join(dir, "provider-homes", "codex"));
      const persisted = JSON.parse(await FS.readFile(store.path, "utf8"));
      expect(persisted.future).toEqual({ untouched: true });
      expect(persisted.profiles[0].future).toBe(42);
      const lock = await acquireInstanceLock(store.instanceLockPath(work));
      try {
        await expect(store.remove(work.id)).rejects.toThrow(/already running/);
      } finally {
        lock.release();
      }
      await store.remove(work.id);
      expect(await FS.stat(dir).catch(() => null)).toBeNull();
      expect((await FS.readdir(Path.join(store.root, ".trash"))).length).toBe(1);
      const next = await store.create({ name: "Next" });
      expect(next.port).not.toBe(work.port);
    } finally {
      await FS.rm(root, { recursive: true, force: true });
    }
  });
  it("fails closed without rewriting malformed, newer, or duplicate registries", async () => {
    const { root, store } = await fixture();
    try {
      await store.init();
      const original = JSON.parse(await FS.readFile(store.path, "utf8"));
      for (const contents of [
        "{",
        JSON.stringify({ version: 99 }),
        JSON.stringify({ ...original, profiles: [original.profiles[0], original.profiles[0]] }),
      ]) {
        await FS.writeFile(store.path, contents);
        expect((await store.init()).ok).toBe(false);
        await expect(store.create({ name: "Unsafe" })).rejects.toThrow();
        expect(await FS.readFile(store.path, "utf8")).toBe(contents);
      }
    } finally {
      await FS.rm(root, { recursive: true, force: true });
    }
  });
});

it("rejects junctions at startup and removal without moving their targets", async () => {
  const { root, store } = await fixture();
  try {
    await store.init();
    const profile = await store.create({ name: "Work" });
    const dir = (await store.list(profile.id)).profiles.find((p) => p.id === profile.id)!.stateDir;
    const outside = Path.join(root, "outside");
    await FS.rename(dir, outside);
    await FS.symlink(outside, dir, process.platform === "win32" ? "junction" : "dir");
    expect((await store.read()).ok).toBe(false);
    await expect(store.remove(profile.id)).rejects.toThrow(/symbolic link|junction/);
    expect(await FS.readFile(Path.join(outside, "settings.json"), "utf8")).toContain(
      "providerInstances",
    );
  } finally {
    await FS.rm(root, { recursive: true, force: true });
  }
});
it("observes three successive atomic registry replacements", async () => {
  const { root, store } = await fixture();
  let notifications = 0;
  try {
    await store.init();
    const close = store.watch(() => notifications++);
    try {
      for (let value = 1; value <= 3; value++) {
        await promisify(execFile)(process.execPath, [
          "-e",
          `
          const fs = require("node:fs"); const file = process.argv[1];
          const registry = JSON.parse(fs.readFileSync(file, "utf8"));
          registry.externalChange = Number(process.argv[2]);
          fs.writeFileSync(file + ".next", JSON.stringify(registry));
          fs.renameSync(file + ".next", file);
        `,
          store.path,
          String(value),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(notifications).toBe(value);
      }
    } finally {
      close();
    }
  } finally {
    await FS.rm(root, { recursive: true, force: true });
  }
});
it("reconciles interrupted provisioning and removal without resurrecting profiles", async () => {
  const { root, store } = await fixture();
  try {
    await store.init();
    const profile = await store.create({ name: "Incomplete" });
    const dir = (await store.list(profile.id)).profiles.find((p) => p.id === profile.id)!.stateDir;
    const registry = JSON.parse(await FS.readFile(store.path, "utf8"));
    registry.profiles.find((p: { id: string }) => p.id === profile.id).status = "removing";
    await FS.writeFile(store.path, JSON.stringify(registry));
    await store.init();
    expect((await store.list(profile.id)).profiles.some((p) => p.id === profile.id)).toBe(false);
    expect(await FS.stat(dir).catch(() => null)).toBeNull();
  } finally {
    await FS.rm(root, { recursive: true, force: true });
  }
});

it("recovers provisioning interrupted after the settings write", async () => {
  const { root, store } = await fixture();
  try {
    await store.init();
    const record = await store.create({ name: "Interrupted" });
    const registry = JSON.parse(await FS.readFile(store.path, "utf8"));
    const pending = registry.profiles.find((p: { id: string }) => p.id === record.id);
    pending.status = "provisioning";
    pending.createdAt = new Date(Date.now() - 700000).toISOString();
    await FS.writeFile(store.path, JSON.stringify(registry));
    await store.init();
    expect((await store.list("")).profiles.some((p) => p.id === record.id)).toBe(false);
    const trash = await FS.readdir(Path.join(store.root, ".trash"));
    expect(trash.some((name) => name.startsWith(record.id))).toBe(true);
  } finally {
    await FS.rm(root, { recursive: true, force: true });
  }
});
