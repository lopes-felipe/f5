import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  fileConsentIo,
  keychainConsentKey,
  SignedRecordFile,
} from "./signedRecordFile";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync), linkSync: vi.fn(actual.linkSync) };
});
afterEach(() => {
  vi.mocked(fs.fsyncSync).mockReset();
  vi.mocked(fs.linkSync).mockReset();
});

const KEY = Buffer.alloc(32, 7);
const options = {
  payload: (profile: string, record: { value: number }) => canonicalJson([profile, record]),
  validate: (value: unknown): value is { value: number } =>
    !!value && typeof value === "object" && "value" in value && typeof value.value === "number",
  revokeFailureMessage: "revoke failed",
  maxProfiles: 2,
  maxRecordsPerProfile: 2,
};
function memory() {
  let contents: string | undefined;
  return {
    read: () => contents,
    write: (value: string) => {
      contents = value;
    },
    remove: () => {
      contents = undefined;
    },
  };
}

describe("SignedRecordFile bounds", () => {
  it("fetches an unavailable signing key once per list, with no lookup for empty/run-only lists", () => {
    const io = memory();
    const original = new SignedRecordFile(io, () => KEY, options);
    original.allow("p", "a", { value: 1 });
    original.allow("p", "b", { value: 2 });
    const key = vi.fn(() => undefined);
    const store = new SignedRecordFile(io, key, options);
    expect(key).not.toHaveBeenCalled();
    expect(store.list("missing")).toEqual([]);
    expect(key).not.toHaveBeenCalled();
    expect(store.list("p")).toEqual([]);
    expect(key).toHaveBeenCalledTimes(1);
    store.allow("q", "run-only", { value: 3 });
    key.mockClear();
    expect(store.list("q")).toEqual([["run-only", { value: 3 }]]);
    expect(key).not.toHaveBeenCalled();
  });

  it("bounds durable and run-only records, while allowing replacements", () => {
    for (const noKey of [false, true]) {
      const store = new SignedRecordFile(memory(), () => (noKey ? undefined : KEY), options);
      store.allow("p", "a", { value: 1 });
      store.allow("p", "b", { value: 2 });
      store.allow("p", "a", { value: 3 });
      expect(() => store.allow("p", "c", { value: 4 })).toThrow("limit");
      store.allow("q", "a", { value: 1 });
      expect(() => store.allow("r", "a", { value: 1 })).toThrow("limit");
    }
  });

  it("bounds loaded profiles and records too", () => {
    const io = memory();
    const store = new SignedRecordFile(io, () => KEY, {
      ...options,
      maxProfiles: 3,
      maxRecordsPerProfile: 3,
    });
    for (const profile of ["p", "q", "r"])
      for (const id of ["a", "b", "c"]) store.allow(profile, id, { value: 1 });
    const loaded = new SignedRecordFile(io, () => KEY, options);
    expect(loaded.profilesList()).toEqual(["p", "q"]);
    expect(loaded.list("p")).toHaveLength(2);
  });
});

describe("durable consent files and key publication", () => {
  const crypto = {
    available: () => true,
    encrypt: (plain: string) => Buffer.from("enc:" + plain),
    decrypt: (encrypted: Buffer) => {
      if (!encrypted.toString().startsWith("enc:")) throw new Error("invalid encrypted key");
      return encrypted.toString().slice(4);
    },
  };

  it("leaves the previous file intact and cleans the temp file when flushing fails", () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "f5-consent-flush-"));
    const path = join(dir, "consent.json");
    const io = fileConsentIo(path);
    io.write("old");
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
      throw new Error("flush failed");
    });
    expect(() => io.write("new")).toThrow("flush failed");
    expect(io.read()).toBe("old");
    expect(fs.readdirSync(dir)).toEqual(["consent.json"]);
  });

  it.skipIf(process.platform === "win32")(
    "falls back to a flushed deletion when directory sync fails",
    async () => {
      const actual = await vi.importActual<typeof fs>("node:fs");
      const dir = fs.mkdtempSync(join(tmpdir(), "f5-consent-revoke-flush-"));
      const path = join(dir, "consent.json");
      const io = fileConsentIo(path);
      const store = new SignedRecordFile(io, () => KEY, options);
      store.allow("profile", "app", { value: 1 });
      let failed = false;
      vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
        if (fs.fstatSync(fd).isDirectory() && !failed) {
          failed = true;
          throw new Error("directory flush failed");
        }
        actual.fsyncSync(fd);
      });
      store.revoke("profile", "app");
      expect(failed).toBe(true);
      expect(fs.existsSync(path)).toBe(false);
      expect(fs.readdirSync(dir)).toEqual([]);
      expect(new SignedRecordFile(io, () => KEY, options).list("profile")).toEqual([]);
    },
  );

  it("never publishes an incomplete key when flushing fails, and can retry creation", () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "f5-consent-key-flush-"));
    const path = join(dir, "key");
    const getter = keychainConsentKey(path, crypto);
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
      throw new Error("flush failed");
    });
    expect(getter()).toBeUndefined();
    expect(fs.readdirSync(dir)).toEqual([]);
    const created = getter();
    expect(created?.length).toBe(32);
    expect(crypto.decrypt(fs.readFileSync(path))).toBe(created!.toString("hex"));
    expect(fs.readdirSync(dir)).toEqual(["key"]);
  });

  it("uses the published winner when another creator wins the exclusive link", () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "f5-consent-key-race-"));
    const path = join(dir, "key");
    const winner = Buffer.alloc(32, 9);
    vi.mocked(fs.linkSync).mockImplementationOnce((_temporary, destination) => {
      fs.writeFileSync(destination, crypto.encrypt(winner.toString("hex")), {
        flag: "wx",
        mode: 0o600,
      });
      throw Object.assign(new Error("another creator won"), { code: "EEXIST" });
    });
    expect(keychainConsentKey(path, crypto)()).toEqual(winner);
    expect(crypto.decrypt(fs.readFileSync(path))).toBe(winner.toString("hex"));
    expect(fs.readdirSync(dir)).toEqual(["key"]);
  });
});
