import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const state = vi.hoisted(() => ({
  posts: 0,
  pages: 0,
  ambiguous: false,
  found: false,
  release: { id: 42, draft: true, prerelease: true, tag_name: "v0.1.2-beta.6", assets: [] },
}));
vi.mock("./release/release-github.ts", () => ({
  repository: "fixture/release",
  gh: () => {
    state.posts++;
    if (state.ambiguous) throw new Error("ECONNRESET");
    return JSON.stringify(state.release);
  },
  pages: () => {
    state.pages++;
    return state.found ? [state.release] : [];
  },
}));
import { createDraft } from "./release/release-remote.ts";
const notes = join(mkdtempSync(join(tmpdir(), "f5-draft-test-")), "notes.md");
writeFileSync(notes, "Fixture release notes\n");
beforeEach(() => {
  state.posts = state.pages = 0;
  state.ambiguous = state.found = false;
  state.release.id = 42;
  state.release.draft = true;
});
afterEach(() => vi.useRealTimers());
it("uses the creation response even when listings have not caught up", async () => {
  const release = await createDraft(state.release.tag_name, true, notes);
  expect(release.id).toBe(42);
  expect(state.posts).toBe(1);
  expect(state.pages).toBe(0);
});
it("discovers one ambiguous creation without issuing another POST", async () => {
  vi.useFakeTimers();
  state.ambiguous = state.found = true;
  const result = createDraft(state.release.tag_name, true, notes);
  await vi.advanceTimersByTimeAsync(5000);
  expect((await result).id).toBe(42);
  expect(state.posts).toBe(1);
  expect(state.pages).toBe(1);
});
it("rejects a mismatched release identity", async () => {
  await expect(createDraft("v9.9.9", true, notes)).rejects.toThrow("different identity");
});
