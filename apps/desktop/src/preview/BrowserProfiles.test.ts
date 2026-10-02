import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { BrowserProfiles, browserPartition } from "./BrowserProfiles";
const directory = () => mkdtemp(path.join(tmpdir(), "f5-browser-profiles-test-"));
describe("browser profiles", () => {
  it("persists persistent profiles but isolates incognito across restarts and F5 profiles", async () => {
    const dir = await directory(),
      clear = vi.fn(async () => {}),
      store = new BrowserProfiles(dir, "f5-one", clear);
    const persistent = await store.create("Work");
    const incognito = await store.create("Private", false);
    expect(browserPartition("f5-one", persistent)).not.toBe(browserPartition("f5-two", persistent));
    expect(browserPartition("f5-one", incognito)).not.toMatch(/^persist:/);
    const restarted = new BrowserProfiles(dir, "f5-one", clear);
    expect((await restarted.list()).map((p) => p.id)).toContain(persistent.id);
    expect((await restarted.list()).map((p) => p.id)).not.toContain(incognito.id);
  });
  it("clears storage before removing metadata and preserves it on a clear failure", async () => {
    const dir = await directory();
    let refuse = true;
    const store = new BrowserProfiles(dir, "f5", async () => {
      if (refuse) throw new Error("locked");
      expect(
        JSON.parse(await readFile(path.join(dir, "preview-browser-profiles.json"), "utf8")).length,
      ).toBe(2);
    });
    const profile = await store.create("Work");
    await expect(store.delete(profile.id)).rejects.toThrow("locked");
    expect((await store.list()).length).toBe(2);
    refuse = false;
    await store.delete(profile.id);
    expect((await store.list()).length).toBe(1);
  });
  it("never exposes a staging import and cleans abandoned stages after restart", async () => {
    const dir = await directory(),
      clear = vi.fn(async () => {}),
      store = new BrowserProfiles(dir, "f5", clear);
    const stage = await store.stage("Import");
    expect((await store.list()).some((p) => p.id === stage.profile.id)).toBe(false);
    const restarted = new BrowserProfiles(dir, "f5", clear);
    await restarted.initialize();
    expect(clear).toHaveBeenCalledWith(stage.partition);
    const fresh = await restarted.stage("Done");
    await fresh.commit();
    await new BrowserProfiles(dir, "f5", clear).initialize();
    expect(clear).not.toHaveBeenCalledWith(fresh.partition);
  });
  it("rejects unowned partitions and invalid scope IDs", async () => {
    const store = new BrowserProfiles(await directory(), "f5", async () => {});
    await store.initialize();
    expect(store.ownsPartition("persist:f5-preview-other-default")).toBe(false);
    expect(() => browserPartition("../escape", { id: "default", persistent: true })).toThrow();
  });
});
