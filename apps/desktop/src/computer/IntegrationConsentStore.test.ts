import { mkdtempSync, readFileSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IntegrationConsentStore,
  disclosuresDigest,
  fileConsentIo,
  keychainConsentKey,
  type IntegrationConsentIo,
} from "./IntegrationConsentStore";

const KEY = Buffer.alloc(32, 7);
const key = () => KEY;

function memoryIo(initial?: string) {
  const state = {
    contents: initial,
    writes: 0,
    failWrites: false,
    failRemove: false,
    removed: 0,
  };
  const io: IntegrationConsentIo = {
    read: () => state.contents,
    write: (contents) => {
      if (state.failWrites) throw new Error("disk full");
      state.writes += 1;
      state.contents = contents;
    },
    remove: () => {
      if (state.failRemove) throw new Error("read-only");
      state.removed += 1;
      state.contents = undefined;
    },
  };
  return { io, state };
}

describe("IntegrationConsentStore", () => {
  it("keeps a signed grant per profile across restarts", () => {
    const { io, state } = memoryIo();
    const store = new IntegrationConsentStore(io, key);
    expect(store.allowed("p1", "codex-chrome")).toBe(false);
    store.allow("p1", "codex-chrome");
    expect(store.allowed("p1", "codex-chrome")).toBe(true);
    expect(store.allowed("p2", "codex-chrome")).toBe(false);
    expect(new IntegrationConsentStore(memoryIo(state.contents).io, key).list("p1")).toEqual([
      "codex-chrome",
    ]);
  });

  it("ignores grants it didn't sign: forged, moved to another profile, or under another key", () => {
    const { io, state } = memoryIo();
    new IntegrationConsentStore(io, key).allow("p1", "codex-chrome");
    const saved = JSON.parse(state.contents!) as Record<string, unknown>;
    const reload = (contents: unknown, withKey: () => Buffer | undefined = key) =>
      new IntegrationConsentStore(memoryIo(JSON.stringify(contents)).io, withKey);
    const digest = disclosuresDigest("codex-chrome");
    expect(reload({ p1: { "codex-chrome": { digest, mac: "0".repeat(64) } } }).list("p1")).toEqual(
      [],
    );
    expect(reload({ p2: saved.p1 }).list("p2")).toEqual([]);
    expect(reload(saved, () => Buffer.alloc(32, 8)).list("p1")).toEqual([]);
    expect(reload(saved, () => undefined).list("p1")).toEqual([]);
  });

  it("revokes and persists the revocation, and a repeat revoke writes again", () => {
    const { io, state } = memoryIo();
    const store = new IntegrationConsentStore(io, key);
    store.allow("p1", "codex-chrome");
    store.revoke("p1", "codex-chrome");
    expect(store.allowed("p1", "codex-chrome")).toBe(false);
    expect(new IntegrationConsentStore(memoryIo(state.contents).io, key).list("p1")).toEqual([]);
    const writes = state.writes;
    store.revoke("p1", "codex-chrome");
    expect(state.writes).toBe(writes + 1);
  });

  it("deletes the file when a revocation can't be written, so the grant never comes back", () => {
    const { io, state } = memoryIo();
    const store = new IntegrationConsentStore(io, key);
    store.allow("p1", "codex-chrome");
    store.allow("p2", "codex-chrome");
    state.failWrites = true;
    store.revoke("p1", "codex-chrome");
    expect(state.removed).toBe(1);
    expect(store.allowed("p1", "codex-chrome")).toBe(false);
    // After a restart nothing is allowed: every profile is asked again.
    expect(new IntegrationConsentStore(memoryIo(state.contents).io, key).list("p1")).toEqual([]);
    expect(new IntegrationConsentStore(memoryIo(state.contents).io, key).list("p2")).toEqual([]);
  });

  it("throws when a revocation can't reach disk at all, and a retry writes it", () => {
    const { io, state } = memoryIo();
    const store = new IntegrationConsentStore(io, key);
    store.allow("p1", "codex-chrome");
    state.failWrites = true;
    state.failRemove = true;
    expect(() => store.revoke("p1", "codex-chrome")).toThrow("couldn't save the revocation");
    // Revoked in memory all the same.
    expect(store.allowed("p1", "codex-chrome")).toBe(false);
    state.failWrites = false;
    store.revoke("p1", "codex-chrome");
    expect(new IntegrationConsentStore(memoryIo(state.contents).io, key).list("p1")).toEqual([]);
  });

  it("asks again once the disclosures the user saw have changed", () => {
    const { io, state } = memoryIo();
    new IntegrationConsentStore(io, key).allow("p1", "codex-chrome");
    const stale = state.contents!.replace(disclosuresDigest("codex-chrome"), "0".repeat(64));
    expect(new IntegrationConsentStore(memoryIo(stale).io, key).list("p1")).toEqual([]);
  });

  it("starts with no grants from a missing, corrupt or foreign file", () => {
    for (const contents of [undefined, "{", "[]", JSON.stringify({ p1: ["codex-chrome"] })])
      expect(new IntegrationConsentStore(memoryIo(contents).io, key).list("p1")).toEqual([]);
    const unsigned = JSON.stringify({ p1: { "codex-chrome": disclosuresDigest("codex-chrome") } });
    expect(new IntegrationConsentStore(memoryIo(unsigned).io, key).list("p1")).toEqual([]);
  });

  it("holds a grant for this run only when it can't be saved or signed", () => {
    const failing = memoryIo();
    failing.state.failWrites = true;
    const store = new IntegrationConsentStore(failing.io, key);
    store.allow("p1", "codex-chrome");
    expect(store.allowed("p1", "codex-chrome")).toBe(true);
    const keyless = memoryIo();
    const unsigned = new IntegrationConsentStore(keyless.io, () => undefined);
    unsigned.allow("p1", "codex-chrome");
    expect(unsigned.allowed("p1", "codex-chrome")).toBe(true);
    expect(keyless.state.writes).toBe(0);
  });

  it("writes the file atomically, private to the user, and reads a missing one as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "consent-"));
    const path = join(dir, "computer", "integration-consent.json");
    const io = fileConsentIo(path);
    expect(io.read()).toBeUndefined();
    io.write("{}");
    expect(readFileSync(path, "utf8")).toBe("{}");
    // Windows has no POSIX modes; its user profile directory carries the ACL instead.
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, "computer"))).toEqual(["integration-consent.json"]);
    io.remove();
    expect(io.read()).toBeUndefined();
    io.remove();
  });

  it("keeps the signing key encrypted and replaces one it can't read", () => {
    const dir = mkdtempSync(join(tmpdir(), "consent-key-"));
    const path = join(dir, "integration-consent.key");
    const crypto = {
      available: () => true,
      encrypt: (plain: string) => Buffer.from(`enc:${plain}`),
      decrypt: (encrypted: Buffer) => {
        const text = encrypted.toString();
        if (!text.startsWith("enc:")) throw new Error("not ours");
        return text.slice(4);
      },
    };
    const first = keychainConsentKey(path, crypto)();
    expect(first?.length).toBe(32);
    expect(readFileSync(path, "utf8")).toBe(`enc:${first!.toString("hex")}`);
    expect(keychainConsentKey(path, crypto)()).toEqual(first);
    writeFileSync(path, "garbage");
    const replaced = keychainConsentKey(path, crypto)();
    expect(replaced?.length).toBe(32);
    expect(replaced).not.toEqual(first);
    expect(keychainConsentKey(path, { ...crypto, available: () => false })()).toBeUndefined();
  });
});
