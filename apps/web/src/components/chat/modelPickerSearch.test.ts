import { describe, expect, it } from "vitest";

import { scoreModelPickerSearch } from "./modelPickerSearch";

const codex = {
  providerKind: "codex" as const,
  modelId: "gpt-5.3-codex",
  name: "GPT-5.3 Codex",
  shortName: "5.3 Codex",
};

const claude = {
  providerKind: "claudeAgent" as const,
  modelId: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  shortName: "Sonnet 4.5",
};

describe("scoreModelPickerSearch", () => {
  it("matches multi-token queries across name and provider fields", () => {
    expect(scoreModelPickerSearch(codex, "gpt codex")).not.toBeNull();
    expect(scoreModelPickerSearch(claude, "claude sonnet")).not.toBeNull();
    expect(scoreModelPickerSearch(claude, "codex sonnet")).toBeNull();
  });

  it("matches fuzzy model queries", () => {
    expect(scoreModelPickerSearch(codex, "g53")).not.toBeNull();
    expect(scoreModelPickerSearch(claude, "snnt")).not.toBeNull();
  });

  it("matches provider names", () => {
    expect(scoreModelPickerSearch(codex, "codex")).not.toBeNull();
    expect(scoreModelPickerSearch(claude, "claude")).not.toBeNull();
  });

  it("boosts favorite results without changing no-query ordering", () => {
    const favoriteScore = scoreModelPickerSearch({ ...claude, isFavorite: true }, "sonnet");
    const plainScore = scoreModelPickerSearch(claude, "sonnet");

    expect(favoriteScore).not.toBeNull();
    expect(plainScore).not.toBeNull();
    expect(favoriteScore!).toBeLessThan(plainScore!);
    expect(scoreModelPickerSearch({ ...claude, isFavorite: true }, "")).toBe(0);
  });

  it("keeps exact slug matches ahead of fuzzy matches", () => {
    const exactScore = scoreModelPickerSearch(codex, "gpt-5.3-codex");
    const fuzzyScore = scoreModelPickerSearch(codex, "g53cod");

    expect(exactScore).not.toBeNull();
    expect(fuzzyScore).not.toBeNull();
    expect(exactScore!).toBeLessThan(fuzzyScore!);
  });
});
