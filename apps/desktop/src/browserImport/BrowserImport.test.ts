import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { BrowserProfiles } from "../preview/BrowserProfiles";
import { BrowserImport } from "./BrowserImport";
const cookie = {
  url: "https://example.test/",
  name: "__Host-token",
  value: "NEVER-LOG-THIS",
  path: "/",
  secure: true,
};
const discover = async () => [
  {
    id: "fixture",
    name: "Fixture",
    profiles: [
      {
        id: "one",
        name: "One",
        database: "/synthetic",
        root: "/synthetic",
        engine: "firefox" as const,
      },
    ],
  },
];
async function make(options: ConstructorParameters<typeof BrowserImport>[2] = {}) {
  const clear = vi.fn(async () => {}),
    store = new BrowserProfiles(await mkdtemp(path.join(tmpdir(), "f5-import-test-")), "f5", clear);
  const cookies = {
    set: vi.fn(async (_cookie: typeof cookie) => {}),
    flushStore: vi.fn(async () => {}),
  };
  return {
    clear,
    store,
    cookies,
    imports: new BrowserImport(store, () => ({ cookies }) as never, {
      discover,
      read: async () => ({ cookies: [cookie], skipped: 2 }),
      ...options,
    }),
  };
}
async function done(imports: BrowserImport, id: string) {
  for (let n = 0; n < 100; n++) {
    const p = imports.status(id);
    if (["completed", "failed", "canceled"].includes(p.status)) return p;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out");
}
describe("staged cookie imports", () => {
  it("publishes only after flush and preserves host-only __Host- cookies", async () => {
    const { imports, store, cookies } = await make();
    const id = await imports.start("fixture", "one", "Imported");
    const result = await done(imports, id);
    expect(result.status).toBe("completed");
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(2);
    expect(cookies.set).toHaveBeenCalledWith(cookie);
    expect(cookies.set.mock.calls[0]?.[0]).not.toHaveProperty("domain");
    expect((await store.list()).some((p) => p.id === result.profileId)).toBe(true);
  });
  it("cancel clears the staging partition and leaves existing profiles untouched", async () => {
    const { imports, store, clear } = await make({
      read: async (_source, signal) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        signal.throwIfAborted();
        return { cookies: [cookie], skipped: 0 };
      },
    });
    const existing = await store.create("Existing");
    const id = await imports.start("fixture", "one", "Canceled");
    imports.cancel(id);
    expect((await done(imports, id)).status).toBe("canceled");
    expect(clear).toHaveBeenCalledOnce();
    expect((await store.list()).map((p) => p.id)).toEqual(["default", existing.id]);
  });
  it("permission/corruption failures are sanitized and never publish partial data", async () => {
    const { imports, store, clear } = await make({
      read: async () => {
        throw new Error(cookie.value);
      },
    });
    const id = await imports.start("fixture", "one", "Failed");
    const result = await done(imports, id);
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain(cookie.value);
    expect(clear).toHaveBeenCalledOnce();
    expect((await store.list()).length).toBe(1);
  });
});
