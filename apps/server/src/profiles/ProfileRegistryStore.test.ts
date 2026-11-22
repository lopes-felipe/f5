import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import * as Net from "node:net";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { describe, it, expect } from "vitest";
import { Schema } from "effect";
import { ServerSettings, ProviderInstanceId, CodexSettings, ProfileId } from "@t3tools/contracts";
import { profileStateDir } from "@t3tools/shared/profilePaths";
import { linuxVmProfilesEnabled, ProfileRegistryStore } from "./ProfileRegistryStore";
import { acquireInstanceLock } from "./InstanceLock";

async function fixture(linuxVmEnabled = false) {
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-profiles-"));
  return {
    root,
    store: new ProfileRegistryStore(Path.join(root, "state"), 4773, linuxVmEnabled),
  };
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
        await expect.poll(() => notifications, { timeout: 5_000 }).toBe(value);
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

it("refuses to remove a profile whose Claude in Chrome setup still owns the real home", async () => {
  const { root, store } = await fixture();
  try {
    await store.init();
    const work = await store.create({ name: "Work" });
    const dir = profileStateDir(store.defaultStateDir, work);
    const wrapper = Path.join(dir, "provider-homes", "claude", ".claude", "chrome", "host");
    const manifest = Path.join(root, "home", "NativeMessagingHosts", "host.json");
    await FS.mkdir(Path.dirname(manifest), { recursive: true });
    const journal = Path.join(dir, "claude-chrome", "transactions");
    await FS.mkdir(journal, { recursive: true });
    await FS.writeFile(
      Path.join(journal, "t.json"),
      JSON.stringify({
        state: "launched",
        targetPath: wrapper,
        slots: [{ kind: "manifest", browser: "chrome", location: manifest }],
      }),
    );
    const registration = (path: string) =>
      JSON.stringify({
        name: "host",
        type: "stdio",
        path,
        allowed_origins: ["chrome-extension://x/"],
      });
    await FS.writeFile(manifest, registration(wrapper));
    await expect(store.remove(work.id)).rejects.toThrow(/Restore it in this profile's Settings/);
    expect(await FS.stat(dir)).toBeTruthy();
    // Once another owner (or a restore) has it, the profile may go.
    await FS.writeFile(manifest, registration("/Users/me/.claude/chrome/host"));
    await store.remove(work.id);
    expect(await FS.stat(dir).catch(() => null)).toBeNull();
  } finally {
    await FS.rm(root, { recursive: true, force: true });
  }
});

describe("execution environments", () => {
  const fileVersion = async (store: ProfileRegistryStore) =>
    JSON.parse(await FS.readFile(store.path, "utf8")).version as number;
  /** A VM record as a VM-capable build would write it; this build can't create one. */
  const writeVmRecord = async (store: ProfileRegistryStore) => {
    const registry = JSON.parse(await FS.readFile(store.path, "utf8"));
    const vm = {
      id: ProfileId.makeUnsafe("f".repeat(32)),
      slug: "guest",
      name: "Guest",
      port: 4799,
      isDefault: false,
      status: "ready",
      createdAt: new Date().toISOString(),
      executionEnvironment: "linux-vm",
    };
    await FS.mkdir(profileStateDir(store.defaultStateDir, vm), { recursive: true });
    await FS.writeFile(
      store.path,
      JSON.stringify({ ...registry, version: 2, profiles: [...registry.profiles, vm] }),
    );
    return vm;
  };

  it("refuses to create a Linux VM profile without touching the registry", async () => {
    const { root, store } = await fixture();
    try {
      await store.init();
      const before = await FS.readFile(store.path, "utf8");
      await expect(
        store.create({ name: "Guest", executionEnvironment: "linux-vm" }),
      ).rejects.toThrow("Linux VM profiles are not available in this build.");
      expect(await FS.readFile(store.path, "utf8")).toBe(before);
    } finally {
      await FS.rm(root, { recursive: true, force: true });
    }
  });

  it("creates a Linux VM profile behind the experiment, with no host provider state", async () => {
    const { root, store } = await fixture(true);
    try {
      await store.init();
      const vm = await store.create({ name: "Guest", executionEnvironment: "linux-vm" });
      expect(vm).toMatchObject({ status: "ready", executionEnvironment: "linux-vm" });
      expect(await fileVersion(store)).toBe(2);
      const directory = profileStateDir(store.defaultStateDir, vm);
      expect(await FS.readdir(directory)).toEqual([]);
      // Windows has no POSIX permission bits.
      if (process.platform !== "win32") expect((await FS.stat(directory)).mode & 0o777).toBe(0o700);
      await store.remove(vm.id);
      expect(await fileVersion(store)).toBe(1);
    } finally {
      await FS.rm(root, { recursive: true, force: true });
    }
  });

  it("enables VM profiles only with the flag on Apple silicon", () => {
    const flag = { F5_EXPERIMENTAL_LINUX_VM: "1" };
    expect(linuxVmProfilesEnabled(flag, "darwin", "arm64")).toBe(true);
    expect(linuxVmProfilesEnabled({}, "darwin", "arm64")).toBe(false);
    expect(linuxVmProfilesEnabled(flag, "darwin", "x64")).toBe(false);
    expect(linuxVmProfilesEnabled(flag, "linux", "arm64")).toBe(false);
  });

  it("writes version 2 only while a Linux VM profile exists", async () => {
    const { root, store } = await fixture();
    try {
      await store.init();
      const host = await store.create({ name: "Host" });
      expect(await fileVersion(store)).toBe(1);
      // Host records stay byte-compatible with builds that predate VM profiles.
      expect(JSON.parse(await FS.readFile(store.path, "utf8")).profiles[1]).not.toHaveProperty(
        "executionEnvironment",
      );
      const vm = await writeVmRecord(store);
      expect((await store.read()).ok).toBe(true);
      // Writes keep version 2 and the environment while the VM profile exists.
      await store.update({ profileId: vm.id, name: "Guest 2" });
      await store.create({ name: "Another host" });
      expect(await fileVersion(store)).toBe(2);
      const read = await store.read();
      expect(read.ok && read.registry.profiles.find((p) => p.id === vm.id)).toMatchObject({
        name: "Guest 2",
        executionEnvironment: "linux-vm",
      });
      await store.remove(vm.id);
      expect(await fileVersion(store)).toBe(1);
      expect((await store.read()).ok).toBe(true);
      await store.remove(host.id);
    } finally {
      await FS.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects VM records in a version 1 registry and a VM Default, without rewriting", async () => {
    const { root, store } = await fixture();
    try {
      await store.init();
      await writeVmRecord(store);
      const v2 = JSON.parse(await FS.readFile(store.path, "utf8"));
      const vmDefault = {
        ...v2,
        profiles: v2.profiles.map((p: { isDefault: boolean }) =>
          p.isDefault ? { ...p, executionEnvironment: "linux-vm" } : p,
        ),
      };
      for (const contents of [
        JSON.stringify({ ...v2, version: 1 }),
        JSON.stringify(vmDefault),
        JSON.stringify({ ...v2, version: 3 }),
      ]) {
        await FS.writeFile(store.path, contents);
        const result = await store.read();
        expect(result.ok).toBe(false);
        await expect(store.create({ name: "Unsafe" })).rejects.toThrow();
        expect(await FS.readFile(store.path, "utf8")).toBe(contents);
      }
      await FS.writeFile(store.path, JSON.stringify({ ...v2, version: 3 }));
      const newer = await store.read();
      expect(!newer.ok && newer.diagnostic.code).toBe("newer-version");
    } finally {
      await FS.rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a version 2 registry without VM profiles and normalizes it on the next write", async () => {
    const { root, store } = await fixture();
    try {
      await store.init();
      const v1 = JSON.parse(await FS.readFile(store.path, "utf8"));
      await FS.writeFile(store.path, JSON.stringify({ ...v1, version: 2 }));
      expect((await store.read()).ok).toBe(true);
      await store.create({ name: "Host" });
      expect(await fileVersion(store)).toBe(1);
    } finally {
      await FS.rm(root, { recursive: true, force: true });
    }
  });
});
