import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  addFavoritePreset,
  applyPresetEffort,
  findCurrentFavoritePresetIndex,
  findNextSelectableFavoritePresetIndex,
  getCurrentEffort,
  listUsableFavoritePresets,
  removeFavoritePreset,
  resolveCurrentFavoritePresetIndex,
  stepFavoritePresetIndex,
  toggleModelFavorite,
  withInstanceFavoriteModels,
  type FavoritePreset,
} from "./favoritePresets";
import type { ProviderInstanceEntry } from "./providerInstances";

const claude = ProviderInstanceId.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");
const work = ProviderInstanceId.make("codex_work");

function entry(
  instanceId: ProviderInstanceId,
  driver: string,
  overrides: Partial<ProviderInstanceEntry> = {},
): ProviderInstanceEntry {
  return {
    instanceId,
    driverKind: ProviderDriverKind.make(driver),
    displayName: instanceId,
    enabled: true,
    installed: true,
    status: "ready",
    isDefault: true,
    isAvailable: true,
    snapshot: {} as ProviderInstanceEntry["snapshot"],
    models: [],
    ...overrides,
  };
}

const options = new Map<ProviderInstanceId, ReadonlyArray<{ slug: string; name: string }>>([
  [
    claude,
    [
      { slug: "claude-opus-5-5", name: "Opus 5.5" },
      { slug: "claude-sonnet-5-5", name: "Sonnet 5.5" },
    ],
  ],
  [codex, [{ slug: "gpt-5.5", name: "GPT-5.5" }]],
  [work, [{ slug: "gpt-5.5", name: "GPT-5.5" }]],
]);

const effortDescriptor = (currentValue?: string): ProviderOptionDescriptor => ({
  id: "effort",
  label: "Effort",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "high", label: "High", isDefault: true },
    { id: "xhigh", label: "Extra high" },
  ],
  ...(currentValue ? { currentValue } : {}),
});

describe("listUsableFavoritePresets", () => {
  it("keeps favorites order and drops unusable instances and removed models", () => {
    const favorites: FavoritePreset[] = [
      { provider: claude, model: "claude-opus-5-5", effort: "xhigh" },
      { provider: work, model: "gpt-5.5" },
      { provider: claude, model: "claude-retired" },
      { provider: codex, model: "gpt-5.5", effort: "medium" },
      { provider: claude, model: "claude-opus-5-5", effort: "high" },
      { provider: ProviderInstanceId.make("missing"), model: "x" },
    ];
    const presets = listUsableFavoritePresets(
      favorites,
      [
        entry(claude, "claudeAgent"),
        entry(codex, "codex"),
        entry(work, "codex", { enabled: false }),
      ],
      options,
    );
    expect(
      presets.map((preset) => [preset.instance.instanceId, preset.model, preset.effort]),
    ).toEqual([
      [claude, "claude-opus-5-5", "xhigh"],
      [codex, "gpt-5.5", "medium"],
      [claude, "claude-opus-5-5", "high"],
    ]);
  });

  it("drops instances in an error state and duplicate presets", () => {
    const favorites: FavoritePreset[] = [
      { provider: claude, model: "claude-opus-5-5" },
      { provider: claude, model: "claude-opus-5-5" },
      { provider: codex, model: "gpt-5.5" },
    ];
    const presets = listUsableFavoritePresets(
      favorites,
      [entry(claude, "claudeAgent"), entry(codex, "codex", { status: "error" })],
      options,
    );
    expect(presets).toHaveLength(1);
  });
});

describe("findCurrentFavoritePresetIndex", () => {
  const presets = listUsableFavoritePresets(
    [
      { provider: claude, model: "claude-opus-5-5" },
      { provider: claude, model: "claude-opus-5-5", effort: "high" },
      { provider: claude, model: "claude-opus-5-5", effort: "xhigh" },
    ],
    [entry(claude, "claudeAgent")],
    options,
  );

  it("prefers an exact effort match", () => {
    expect(
      findCurrentFavoritePresetIndex(presets, {
        instanceId: claude,
        model: "claude-opus-5-5",
        effort: "xhigh",
      }),
    ).toBe(2);
  });

  it("falls back to the first preset for the model", () => {
    expect(
      findCurrentFavoritePresetIndex(presets, {
        instanceId: claude,
        model: "claude-opus-5-5",
        effort: "low",
      }),
    ).toBe(0);
  });

  it("returns -1 when the composer model is not a favorite", () => {
    expect(
      findCurrentFavoritePresetIndex(presets, {
        instanceId: claude,
        model: "claude-sonnet-5-5",
        effort: null,
      }),
    ).toBe(-1);
  });
});

describe("stepFavoritePresetIndex", () => {
  it("wraps in both directions", () => {
    expect(stepFavoritePresetIndex(3, 2, 1)).toBe(0);
    expect(stepFavoritePresetIndex(3, 0, -1)).toBe(2);
    expect(stepFavoritePresetIndex(3, 1, 1)).toBe(2);
  });

  it("starts at either end from no current preset", () => {
    expect(stepFavoritePresetIndex(3, -1, 1)).toBe(0);
    expect(stepFavoritePresetIndex(3, -1, -1)).toBe(2);
    expect(stepFavoritePresetIndex(0, -1, 1)).toBe(-1);
  });
});

describe("cycling over mixed presets of one model", () => {
  // Starring creates an effort-less preset, and "Save current" adds pinned ones.
  const favorites: FavoritePreset[] = [
    { provider: claude, model: "claude-opus-5-5" },
    { provider: claude, model: "claude-opus-5-5", effort: "high" },
    { provider: claude, model: "claude-opus-5-5", effort: "xhigh" },
    { provider: codex, model: "gpt-5.5" },
  ];
  const presets = listUsableFavoritePresets(
    favorites,
    [entry(claude, "claudeAgent"), entry(codex, "codex")],
    options,
  );

  // Mirrors the composer: each model keeps a sticky effort, a pinned preset
  // updates it, and an effort-less preset leaves it alone.
  function lap(direction: 1 | -1, steps: number): number[] {
    const sticky = new Map<string, string>([
      ["claude-opus-5-5", "low"],
      ["gpt-5.5", "medium"],
    ]);
    let state = {
      instanceId: claude as ProviderInstanceId,
      model: "claude-opus-5-5",
      effort: "low" as string | null,
      last: null as FavoritePreset | null,
    };
    const visited: number[] = [];
    for (let step = 0; step < steps; step += 1) {
      const current = resolveCurrentFavoritePresetIndex(presets, state, state.last);
      const next = findNextSelectableFavoritePresetIndex(presets, current, direction, () => true);
      const preset = presets[next]!;
      visited.push(next);
      if (preset.effort) sticky.set(preset.model, preset.effort);
      state = {
        instanceId: preset.instance.instanceId,
        model: preset.model,
        effort: sticky.get(preset.model) ?? null,
        last: preset.favorite,
      };
    }
    return visited;
  }

  it("visits every preset in order going forward", () => {
    expect(lap(1, 8)).toEqual([1, 2, 3, 0, 1, 2, 3, 0]);
  });

  it("visits every preset in order going backward", () => {
    expect(lap(-1, 8)).toEqual([3, 2, 1, 0, 3, 2, 1, 0]);
  });

  it("drops the applied preset once the composer no longer shows it", () => {
    // After the effort is stepped away from a pinned preset, matching starts over.
    expect(
      resolveCurrentFavoritePresetIndex(
        presets,
        { instanceId: claude, model: "claude-opus-5-5", effort: "low" },
        favorites[2]!,
      ),
    ).toBe(0);
    // An effort-less preset stays current whatever the effort.
    expect(
      resolveCurrentFavoritePresetIndex(
        presets,
        { instanceId: claude, model: "claude-opus-5-5", effort: "xhigh" },
        favorites[0]!,
      ),
    ).toBe(0);
  });

  it("skips presets the provider lock refuses, and gives up after one lap", () => {
    const claudeOnly = (preset: (typeof presets)[number]) => preset.instance.instanceId === claude;
    expect(findNextSelectableFavoritePresetIndex(presets, 2, 1, claudeOnly)).toBe(0);
    expect(findNextSelectableFavoritePresetIndex(presets, 0, -1, claudeOnly)).toBe(2);
    expect(findNextSelectableFavoritePresetIndex(presets, 0, 1, () => false)).toBe(-1);
  });
});

describe("applyPresetEffort", () => {
  it("sets a supported effort and keeps unrelated traits", () => {
    expect(
      applyPresetEffort(
        [effortDescriptor("low")],
        [
          { id: "effort", value: "low" },
          { id: "fastMode", value: true },
        ],
        "xhigh",
      ),
    ).toEqual([
      { id: "fastMode", value: true },
      { id: "effort", value: "xhigh" },
    ]);
  });

  it("returns null for an effort the model doesn't offer", () => {
    expect(applyPresetEffort([effortDescriptor()], [], "max")).toBeNull();
  });

  it("returns null for a model without an effort select", () => {
    expect(
      applyPresetEffort(
        [{ id: "fastMode", label: "Fast", type: "boolean", currentValue: false }],
        [],
        "high",
      ),
    ).toBeNull();
  });

  it("reads the current effort, falling back to the default", () => {
    expect(getCurrentEffort([effortDescriptor("xhigh")])).toBe("xhigh");
    expect(getCurrentEffort([effortDescriptor()])).toBe("high");
    expect(getCurrentEffort([])).toBeNull();
  });
});

describe("favorites editing", () => {
  const opusHigh = { provider: claude, model: "claude-opus-5-5", effort: "high" };
  const opusXhigh = { provider: claude, model: "claude-opus-5-5", effort: "xhigh" };
  const gpt = { provider: codex, model: "gpt-5.5" };

  it("adds a preset once", () => {
    const first = addFavoritePreset([gpt], opusHigh);
    expect(first).toEqual({ favorites: [gpt, opusHigh], added: true });
    expect(addFavoritePreset(first.favorites, { ...opusHigh }).added).toBe(false);
  });

  it("removes only the matching preset", () => {
    expect(removeFavoritePreset([opusHigh, opusXhigh, gpt], opusXhigh)).toEqual([opusHigh, gpt]);
  });

  it("toggles a model's presets as one favorite", () => {
    expect(toggleModelFavorite([opusHigh, gpt, opusXhigh], claude, "claude-opus-5-5")).toEqual([
      gpt,
    ]);
    expect(toggleModelFavorite([gpt], claude, "claude-opus-5-5")).toEqual([
      gpt,
      { provider: claude, model: "claude-opus-5-5" },
    ]);
  });

  it("keeps effort presets and positions when Settings rewrites an instance's favorites", () => {
    const sonnet = { provider: claude, model: "claude-sonnet-5-5" };
    expect(
      withInstanceFavoriteModels([opusHigh, gpt, sonnet, opusXhigh], claude, [
        "claude-opus-5-5",
        "claude-haiku-5-5",
      ]),
    ).toEqual([opusHigh, gpt, opusXhigh, { provider: claude, model: "claude-haiku-5-5" }]);
  });
});
