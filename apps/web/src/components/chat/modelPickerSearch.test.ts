import type { ProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { rankModelPickerSearch, scoreModelPickerSearch } from "./modelPickerSearch";

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

type CatalogModel = {
  providerKind: ProviderKind;
  modelId: string;
  name: string;
  subProvider?: string;
  isFavorite?: boolean;
};

function instanceModels(providerKind: ProviderKind, names: ReadonlyArray<string>): CatalogModel[] {
  return names.map((name) => ({
    providerKind,
    modelId: name.toLowerCase().replace(/[()]/gu, "").replace(/\s+/gu, "-"),
    name,
  }));
}

// Each provider lists its models newest first, as the picker receives them.
const catalog: CatalogModel[] = [
  ...instanceModels("claudeAgent", [
    "Claude Opus 5.5",
    "Claude Sonnet 5.5",
    "Claude Fable 5.1",
    "Claude Fable 5",
    "Claude Opus 5",
    "Claude Opus 4.8",
    "Claude Opus 4.7",
    "Claude Opus 4.6",
    "Claude Opus 4.5",
    "Claude Sonnet 5",
    "Claude Sonnet 4.6",
    "Claude Haiku 5.5",
    "Claude Haiku 4.5",
  ]),
  ...instanceModels("codex", [
    "GPT-6.1 Sol",
    "GPT-6 Astra",
    "GPT-6 Luna",
    "GPT-6 Sol",
    "GPT-5.6 Sol",
    "GPT-5.6 Terra",
    "GPT-5.6 Luna",
    "GPT-5.5",
  ]),
  ...instanceModels("grok", ["Grok 4.7", "Grok 4.6", "Grok 4.5"]),
  ...instanceModels("antigravity", [
    "Gemini 3.8 Flash (High)",
    "Gemini 3.8 Flash (Low)",
    "Gemini 3.7 Flash (High)",
    "Gemini 3.7 Flash (Low)",
    "Gemini 3.1 Pro (High)",
  ]),
  ...(["Kimi K3", "Kimi K2.5", "Kimi K2"] as const).map((name) => ({
    providerKind: "opencode" as const,
    modelId: `moonshot/${name.toLowerCase().replace(/\s+/gu, "-")}`,
    name,
    subProvider: "Moonshot",
  })),
];

function search(query: string, models: ReadonlyArray<CatalogModel> = catalog): string[] {
  return rankModelPickerSearch(models, query, (model) => model).map((model) => model.name);
}

describe("rankModelPickerSearch", () => {
  it.each([
    [
      "opus",
      [
        "Claude Opus 5.5",
        "Claude Opus 5",
        "Claude Opus 4.8",
        "Claude Opus 4.7",
        "Claude Opus 4.6",
        "Claude Opus 4.5",
      ],
    ],
    ["sonnet", ["Claude Sonnet 5.5", "Claude Sonnet 5", "Claude Sonnet 4.6"]],
    ["haiku", ["Claude Haiku 5.5", "Claude Haiku 4.5"]],
    [
      "gpt",
      [
        "GPT-6.1 Sol",
        "GPT-6 Astra",
        "GPT-6 Luna",
        "GPT-6 Sol",
        "GPT-5.6 Sol",
        "GPT-5.6 Terra",
        "GPT-5.6 Luna",
        "GPT-5.5",
      ],
    ],
    ["sol", ["GPT-6.1 Sol", "GPT-6 Sol", "GPT-5.6 Sol"]],
    ["grok", ["Grok 4.7", "Grok 4.6", "Grok 4.5"]],
    [
      "flash",
      [
        "Gemini 3.8 Flash (High)",
        "Gemini 3.8 Flash (Low)",
        "Gemini 3.7 Flash (High)",
        "Gemini 3.7 Flash (Low)",
      ],
    ],
    ["kimi", ["Kimi K3", "Kimi K2.5", "Kimi K2"]],
  ])("lists equally good matches for %j newest first", (query, expected) => {
    // Loose fuzzy matches from other families may follow; they rank last.
    expect(search(query).slice(0, expected.length)).toEqual(expected);
  });

  it("still ranks an exact name above newer models that extend it", () => {
    expect(search("gpt-6 sol").slice(0, 2)).toEqual(["GPT-6 Sol", "GPT-6.1 Sol"]);
    expect(search("claude opus 5").slice(0, 2)).toEqual(["Claude Opus 5", "Claude Opus 5.5"]);
    expect(search("  claude   opus 5 ")[0]).toBe("Claude Opus 5");
  });

  it("ranks an exact name above a favorite partial match", () => {
    const models = catalog.map((model) =>
      model.name === "Claude Opus 5.5" ? { ...model, isFavorite: true } : model,
    );
    expect(search("claude opus 5", models)[0]).toBe("Claude Opus 5");
  });

  it("ranks a favorite above newer models in the same family", () => {
    const models = catalog.map((model) =>
      model.name === "Claude Opus 4.5" ? { ...model, isFavorite: true } : model,
    );
    expect(search("opus", models).slice(0, 3)).toEqual([
      "Claude Opus 4.5",
      "Claude Opus 5.5",
      "Claude Opus 5",
    ]);
  });

  it("follows the order it is given, including a custom model order", () => {
    expect(search("grok", catalog.toReversed())).toEqual(["Grok 4.5", "Grok 4.6", "Grok 4.7"]);
  });
});
