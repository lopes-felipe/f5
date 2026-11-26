import { afterEach, describe, expect, it } from "vitest";
import { homeComposerDraft, useHomeComposerTextStore } from "./homeComposerDraft";

afterEach(() => {
  homeComposerDraft.resetForTests();
});

describe("homeComposerDraft", () => {
  it("persists chosenEnvMode per selection across store reads and resets via resetForTests", () => {
    expect(homeComposerDraft.envMode("project-a")).toBeNull();

    homeComposerDraft.setEnvMode("project-a", "worktree");
    expect(homeComposerDraft.envMode("project-a")).toBe("worktree");
    expect(homeComposerDraft.envMode("project-b")).toBeNull();
    expect(useHomeComposerTextStore.getState().chosenEnvMode).toEqual({
      selection: "project-a",
      mode: "worktree",
    });

    homeComposerDraft.resetForTests();
    expect(homeComposerDraft.envMode("project-a")).toBeNull();
    expect(useHomeComposerTextStore.getState().chosenEnvMode).toBeNull();
  });
});
