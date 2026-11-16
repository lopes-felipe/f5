import * as NodeServices from "@effect/platform-node/NodeServices";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseNativeHostManifest } from "./chromeNativeHost";
import {
  ChromeLaunchTimeout,
  ChromeNativeHostTransactions,
  ChromeRestoreBlocked,
  isStaleTransaction,
  type ChromeJournalStorage,
} from "./chromeNativeHostJournal";
import {
  decodeChromeTransaction,
  makeChromeNativeHostStorage,
  readChromeArtifact,
} from "./chromeNativeHostStorage";

let root: string;
let stateDir: string;
let manifestPath: string;
let wrapperPath: string;
const TARGET = "/profile/claude/chrome/chrome-native-host";
const manifest = (path: string) =>
  JSON.stringify({ name: "host", type: "stdio", path, allowed_origins: ["chrome-extension://a/"] });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "f5-chrome-journal-"));
  stateDir = join(root, "state");
  manifestPath = join(root, "NativeMessagingHosts", "host.json");
  wrapperPath = join(root, "wrapper");
  await mkdir(join(root, "NativeMessagingHosts"), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const inspect = async () => {
  const read = await readChromeArtifact(manifestPath);
  return [parseNativeHostManifest("chrome", manifestPath, read.bytes)];
};
const create = (overrides: Partial<Parameters<typeof makeChromeNativeHostStorage>[0]> = {}) =>
  Effect.runPromise(
    makeChromeNativeHostStorage({ stateDir, inspect, ...overrides }).pipe(
      Effect.provide(NodeServices.layer),
    ),
  );
const approve = async (storage: ChromeJournalStorage, profileId = "p") =>
  new ChromeNativeHostTransactions(storage).approve({
    provider: "claude",
    profileId,
    providerInstanceId: "claudeAgent",
    recordId: "claude-chrome-darwin-arm64-2.1.295",
    providerHome: "/profile/claude",
    userHome: root,
    targetPath: TARGET,
    wrapperLocation: wrapperPath,
    observed: await inspect(),
    acceptedForeign: [],
  });
/** Simulates the CLI writing its registration and wrapper. */
const launch = async () => {
  await writeFile(manifestPath, manifest(TARGET));
  await writeFile(wrapperPath, "#!/bin/sh\nexec /x --chrome-native-host\n", { mode: 0o755 });
};
const restoreOptions = { stopSessions: async () => {}, validateSlot: async () => true };

describe("Chrome journal storage", () => {
  it("persists v2 transactions outside settings and rejects identity drift", async () => {
    const storage = await create();
    const approved = await approve(storage);
    const restarted = await create();
    expect(await restarted.loadTransaction("claude", approved.id)).toEqual(approved);
    expect(await restarted.listTransactions("claude")).toEqual([approved]);
    await expect(restarted.loadTransaction("claude", "../../outside")).rejects.toThrow();
    const file = join(stateDir, "claude-chrome", "transactions", `${approved.id}.json`);
    const bytes = await readFile(file, "utf8");
    await writeFile(
      file,
      JSON.stringify({ ...JSON.parse(bytes), id: "00000000-0000-0000-0000-000000000000" }),
    );
    await expect(restarted.loadTransaction("claude", approved.id)).rejects.toThrow(
      "identity mismatch",
    );
  });

  it("converts v1 journals conservatively", () => {
    const converted = decodeChromeTransaction({
      id: "00000000-0000-0000-0000-000000000001",
      provider: "claude",
      profileId: "p",
      targetPath: TARGET,
      createdAt: "2026-01-01T00:00:00.000Z",
      state: "launched",
      registrations: [
        {
          browser: "chrome",
          location: "/a",
          originalBytes: null,
          originalHash: null,
          postLaunchHash: "h",
        },
      ],
    });
    expect(converted).toMatchObject({
      version: 2,
      legacy: true,
      recordId: "",
      slots: [{ kind: "manifest" }],
    });
  });

  it("never reads through a symlink", async () => {
    await writeFile(join(root, "real"), "x");
    await symlink(join(root, "real"), join(root, "link"));
    await expect(readChromeArtifact(join(root, "link"))).rejects.toThrow("not a regular file");
    expect(await readChromeArtifact(join(root, "missing"))).toEqual({ bytes: null });
  });
});

// Restore checks POSIX file modes, which Windows does not keep.
describe.skipIf(process.platform === "win32")("Chrome journal lifecycle", () => {
  it("records original bytes and absence before launch, then restores exactly", async () => {
    await writeFile(manifestPath, manifest("/foreign"), { mode: 0o640 });
    const storage = await create();
    const transactions = new ChromeNativeHostTransactions(storage);
    const approved = await approve(storage);
    expect(approved.slots.map((slot) => [slot.kind, slot.originalBytes === null])).toEqual([
      ["manifest", false],
      ["wrapper", true],
    ]);
    await launch();
    const launched = await transactions.recordLaunch(approved, {
      allowedOrigins: ["chrome-extension://a/"],
    });
    expect(launched).toMatchObject({ state: "launched", launchVerified: true });
    expect(launched.slots.every((slot) => slot.postLaunchHash)).toBe(true);

    const result = await transactions.restore(launched, restoreOptions);
    expect(result.restored).toEqual([manifestPath, wrapperPath]);
    expect(result.transaction.state).toBe("restored");
    expect(await readFile(manifestPath, "utf8")).toBe(manifest("/foreign"));
    expect((await stat(manifestPath)).mode & 0o777).toBe(0o640);
    expect(await readChromeArtifact(wrapperPath)).toEqual({ bytes: null });
    // Idempotent.
    expect((await transactions.restore(result.transaction, restoreOptions)).restored).toEqual([]);
  });

  it("persists a partial journal on launch timeout so the setup stays restorable", async () => {
    const storage = await create();
    const transactions = new ChromeNativeHostTransactions(storage);
    const approved = await approve(storage);
    await writeFile(wrapperPath, "#!/bin/sh\n");
    const error = await transactions
      .recordLaunch(approved, { timeoutMs: 30, intervalMs: 5 })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ChromeLaunchTimeout);
    const saved = await storage.loadTransaction("claude", approved.id);
    expect(saved).toMatchObject({ state: "launched", launchVerified: false });
    const result = await transactions.restore(saved!, restoreOptions);
    expect(result.restored).toContain(wrapperPath);
  });

  it("skips artifacts changed by someone else and keeps them retryable", async () => {
    const storage = await create();
    const transactions = new ChromeNativeHostTransactions(storage);
    const approved = await approve(storage);
    await launch();
    const launched = await transactions.recordLaunch(approved);
    await writeFile(wrapperPath, "user edit\n");
    const result = await transactions.restore(launched, restoreOptions);
    expect(result.skipped).toEqual([wrapperPath]);
    expect(result.transaction.state).toBe("partially-restored");
    expect(await readFile(wrapperPath, "utf8")).toBe("user edit\n");
  });

  it("refuses an older restore while a newer transaction owns the same paths, before stopping sessions", async () => {
    const storage = await create();
    const transactions = new ChromeNativeHostTransactions(storage);
    const older = await approve(storage);
    await launch();
    const olderLaunched = await transactions.recordLaunch(older);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await approve(storage);
    let stopped = false;
    await expect(
      transactions.restore(olderLaunched, {
        ...restoreOptions,
        stopSessions: async () => void (stopped = true),
      }),
    ).rejects.toBeInstanceOf(ChromeRestoreBlocked);
    expect(stopped).toBe(false);
    expect(newer.slots[0]?.predecessor).toBe(older.id);
  });

  it("marks recovery-required on a failed write and reconciles a crash after the write", async () => {
    let fail = true;
    const storage = await create({
      writeArtifact: async (location, bytes) => {
        if (fail) throw new Error("disk full");
        if (bytes === null) await rm(location, { force: true });
        else await writeFile(location, bytes);
      },
    });
    const transactions = new ChromeNativeHostTransactions(storage);
    const approved = await approve(storage);
    await launch();
    const launched = await transactions.recordLaunch(approved);
    await expect(transactions.restore(launched, restoreOptions)).rejects.toThrow("disk full");
    const failed = await storage.loadTransaction("claude", approved.id);
    expect(failed?.state).toBe("recovery-required");
    expect(failed?.slots.some((slot) => slot.outcome === "restoring" && slot.intent)).toBe(true);

    // The write landed but the journal update did not: reconcile finishes the slot.
    await rm(manifestPath);
    const reconciled = await transactions.reconcile(failed!);
    expect(reconciled.slots[0]).toMatchObject({ outcome: "restored" });
    expect(reconciled.slots[0]?.intent).toBeUndefined();
    fail = false;
    expect((await transactions.restore(reconciled, restoreOptions)).transaction.state).toBe(
      "restored",
    );
  });

  it("leaves slots the record no longer vouches for unresolved", async () => {
    const storage = await create();
    const transactions = new ChromeNativeHostTransactions(storage);
    const approved = await approve(storage);
    await launch();
    const launched = await transactions.recordLaunch(approved);
    const result = await transactions.restore(launched, {
      ...restoreOptions,
      validateSlot: async (_tx, slot) => slot.kind === "manifest",
    });
    expect(result.unresolved).toEqual([wrapperPath]);
    expect(await readChromeArtifact(wrapperPath)).not.toEqual({ bytes: null });
  });

  it("treats a missing wrapper or a missing target as stale", async () => {
    const storage = await create();
    const approved = await approve(storage);
    expect(isStaleTransaction(approved, null, true)).toBe(true);
    expect(isStaleTransaction(approved, "bytes", false)).toBe(true);
    expect(isStaleTransaction(approved, "bytes", true)).toBe(false);
  });
});
