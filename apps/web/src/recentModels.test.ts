import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { isMostRecentModel, MAX_RECENT_MODELS, recordRecentModel } from "./recentModels";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const work = ProviderInstanceId.make("codex_work");

describe("recordRecentModel", () => {
  it("puts the pick first", () => {
    expect(recordRecentModel([], codex, "gpt-5.5")).toEqual([
      { provider: codex, model: "gpt-5.5" },
    ]);
    expect(
      recordRecentModel([{ provider: codex, model: "gpt-5.5" }], claude, "claude-opus-5-5"),
    ).toEqual([
      { provider: claude, model: "claude-opus-5-5" },
      { provider: codex, model: "gpt-5.5" },
    ]);
  });

  it("moves an existing pick to the front instead of duplicating it", () => {
    const recents = [
      { provider: claude, model: "claude-opus-5-5" },
      { provider: codex, model: "gpt-5.5" },
    ];
    expect(recordRecentModel(recents, codex, "gpt-5.5")).toEqual([
      { provider: codex, model: "gpt-5.5" },
      { provider: claude, model: "claude-opus-5-5" },
    ]);
  });

  it("keeps the same model on different instances apart", () => {
    expect(recordRecentModel([{ provider: codex, model: "gpt-5.5" }], work, "gpt-5.5")).toEqual([
      { provider: work, model: "gpt-5.5" },
      { provider: codex, model: "gpt-5.5" },
    ]);
  });

  it("keeps at most three, dropping the oldest", () => {
    let recents = recordRecentModel([], codex, "a");
    recents = recordRecentModel(recents, codex, "b");
    recents = recordRecentModel(recents, codex, "c");
    recents = recordRecentModel(recents, codex, "d");
    expect(recents).toHaveLength(MAX_RECENT_MODELS);
    expect(recents.map((entry) => entry.model)).toEqual(["d", "c", "b"]);
  });
});

describe("isMostRecentModel", () => {
  it("matches only the first entry", () => {
    const recents = [
      { provider: codex, model: "gpt-5.5" },
      { provider: claude, model: "claude-opus-5-5" },
    ];
    expect(isMostRecentModel(recents, codex, "gpt-5.5")).toBe(true);
    expect(isMostRecentModel(recents, claude, "claude-opus-5-5")).toBe(false);
    expect(isMostRecentModel([], codex, "gpt-5.5")).toBe(false);
  });
});
