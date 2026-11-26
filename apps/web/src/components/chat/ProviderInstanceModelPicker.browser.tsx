import "../../index.css";

import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ModelSlug,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { createTestServerProvider } from "../../testServerProvider";
import { sortModelsForProviderInstance } from "../../modelOrdering";
import { TooltipProvider } from "../ui/tooltip";
import { ProviderInstanceModelPicker } from "./ProviderInstanceModelPicker";

const settingsMock = vi.hoisted(() => ({
  favorites: [] as Array<{ provider: string; model: string; effort?: string }>,
  recentModels: [] as Array<{ provider: string; model: string }>,
  updateSettings: vi.fn(),
}));

vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => ({
    favorites: settingsMock.favorites,
    recentModels: settingsMock.recentModels,
  }),
  useUpdateSettings: () => ({ updateSettings: settingsMock.updateSettings }),
}));

/** Rows of one section kind, in display order. */
function sectionRows(section: "recent" | "favorites" | "provider"): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      `[data-model-picker-row][data-model-picker-section="${section}"]`,
    ),
  ];
}

function rowName(row: HTMLElement): string {
  return row.querySelector("[data-model-picker-name]")?.textContent ?? "";
}

/** The visible section groups, by accessible name. */
function groupNames(): string[] {
  return [...document.querySelectorAll<HTMLElement>('section[role="group"]')].map(
    (group) => group.getAttribute("aria-label") ?? "",
  );
}

const CODEX_ID = defaultInstanceIdForDriver(ProviderDriverKind.make("codex"));
const CLAUDE_ID = defaultInstanceIdForDriver(ProviderDriverKind.make("claudeAgent"));
const CURSOR_ID = defaultInstanceIdForDriver(ProviderDriverKind.make("cursor"));

const PROVIDERS: ServerProvider[] = [
  createTestServerProvider("codex"),
  createTestServerProvider("claudeAgent"),
  createTestServerProvider("cursor"),
];

const MODELS = new Map([
  [CODEX_ID, [{ slug: "gpt-5.6-sol", name: "GPT-5.6 Sol" }]],
  [
    CLAUDE_ID,
    [
      { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { slug: "claude-fable-5-1", name: "Claude Fable 5.1" },
    ],
  ],
  [
    CURSOR_ID,
    [
      { slug: "auto", name: "Auto" },
      { slug: "claude-opus-4-6", name: "Claude Opus 4.6" },
    ],
  ],
]) satisfies ReadonlyMap<ProviderInstanceId, ReadonlyArray<{ slug: string; name: string }>>;

let active: Awaited<ReturnType<typeof render>> | undefined;

afterEach(async () => {
  await active?.unmount();
  active = undefined;
  settingsMock.favorites = [];
  settingsMock.recentModels = [];
  settingsMock.updateSettings.mockReset();
  await page.viewport(1024, 900);
});

describe("ProviderInstanceModelPicker favorite presets", () => {
  const isMac = /Mac/u.test(navigator.platform);
  const presets = [
    { provider: CODEX_ID, model: "gpt-5.6-sol" },
    { provider: CLAUDE_ID, model: "claude-fable-5-1", effort: "high" },
    { provider: CLAUDE_ID, model: "claude-fable-5-1", effort: "xhigh" },
  ];

  async function renderPicker(
    onChange = vi.fn(),
    activePreset: (typeof presets)[number] | null = null,
    lockedInstanceId: ProviderInstanceId | null = null,
  ) {
    settingsMock.favorites = presets;
    active = await render(
      <TooltipProvider delay={0}>
        <ProviderInstanceModelPicker
          instanceId={CLAUDE_ID}
          model="claude-fable-5-1"
          lockedInstanceId={lockedInstanceId}
          providers={PROVIDERS}
          modelOptionsByInstance={MODELS}
          keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
          favoritePresets
          activePreset={activePreset}
          onInstanceModelChange={onChange}
        />
      </TooltipProvider>,
    );
    await page.getByRole("button", { name: /Claude Fable 5.1/ }).click();
    await expect.element(page.getByPlaceholder("Search models...")).toBeVisible();
    return onChange;
  }

  it("lists one row per preset in favorites order with effort chips and jump keys", async () => {
    await renderPicker(vi.fn(), presets[2]!);
    const rows = () =>
      sectionRows("favorites").map((row) => ({
        effort: row.querySelector("[data-model-picker-preset-effort]")?.textContent ?? null,
        active: row.hasAttribute("data-model-picker-active"),
        jump: row.querySelector("kbd")?.textContent ?? null,
      }));
    await expect.poll(() => rows().length).toBe(3);
    const mod = isMac ? "⌘" : "Ctrl+";
    expect(rows()).toEqual([
      { effort: null, active: false, jump: `${mod}1` },
      { effort: "high", active: false, jump: `${mod}2` },
      { effort: "xhigh", active: true, jump: `${mod}3` },
    ]);
    // Number hints belong to Favorites only; provider rows carry none.
    expect(sectionRows("provider").some((row) => row.querySelector("kbd"))).toBe(false);
  });

  it("picks a preset row with mod+N, passes its preset and records it as recent", async () => {
    const onChange = await renderPicker();
    await userEvent.keyboard(isMac ? "{Meta>}3{/Meta}" : "{Control>}3{/Control}");
    await expect
      .poll(() => onChange.mock.calls)
      .toEqual([[CLAUDE_ID, "claudeAgent", "claude-fable-5-1", presets[2]]]);
    expect(settingsMock.updateSettings).toHaveBeenCalledWith({
      recentModels: [{ provider: CLAUDE_ID, model: "claude-fable-5-1" }],
    });
  });

  it("picks favorite N with mod+N from another chip and while searching", async () => {
    const onChange = await renderPicker();
    await page.getByRole("button", { name: "Cursor", exact: true }).click();
    await page.getByPlaceholder("Search models...").fill("auto");
    await userEvent.keyboard(isMac ? "{Meta>}1{/Meta}" : "{Control>}1{/Control}");
    await expect
      .poll(() => onChange.mock.calls)
      .toEqual([[CODEX_ID, "codex", "gpt-5.6-sol", presets[0]]]);
  });

  it("keeps favorite numbers in a locked thread so mod+N matches ctrl+N", async () => {
    const onChange = await renderPicker(vi.fn(), null, CLAUDE_ID);
    expect(document.querySelector("[data-model-picker-provider]")).toBeNull();
    const jumps = () =>
      sectionRows("favorites").map((row) => row.querySelector("kbd")?.textContent ?? null);
    await expect.poll(() => jumps().length).toBe(2);
    const mod = isMac ? "⌘" : "Ctrl+";
    // Favorite 1 is on Codex, hidden here; the Claude presets keep numbers 2 and 3.
    expect(jumps()).toEqual([`${mod}2`, `${mod}3`]);
    await userEvent.keyboard(isMac ? "{Meta>}1{/Meta}" : "{Control>}1{/Control}");
    await userEvent.keyboard(isMac ? "{Meta>}2{/Meta}" : "{Control>}2{/Control}");
    await expect
      .poll(() => onChange.mock.calls)
      .toEqual([[CLAUDE_ID, "claudeAgent", "claude-fable-5-1", presets[1]]]);
  });

  it("removes only the starred preset", async () => {
    await renderPicker();
    await page
      .getByRole("button", { name: "Remove Claude Fable 5.1 · high from favorites" })
      .click();
    expect(settingsMock.updateSettings).toHaveBeenCalledWith({
      favorites: [presets[0], presets[2]],
    });
  });

  it("lists each model once and passes no effort without favoritePresets", async () => {
    settingsMock.favorites = presets;
    const onChange = vi.fn();
    active = await render(
      <TooltipProvider delay={0}>
        <ProviderInstanceModelPicker
          instanceId={CLAUDE_ID}
          model="claude-fable-5-1"
          lockedInstanceId={null}
          providers={PROVIDERS}
          modelOptionsByInstance={MODELS}
          keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
          onInstanceModelChange={onChange}
        />
      </TooltipProvider>,
    );
    await page.getByRole("button", { name: /Claude Fable 5.1/ }).click();
    await expect.poll(() => sectionRows("favorites").length).toBe(2);
    expect(document.querySelector("[data-model-picker-preset-effort]")).toBeNull();
    // Favorites that differ only by effort collapse to one row, so numbers follow the rows.
    const mod = isMac ? "⌘" : "Ctrl+";
    expect(sectionRows("favorites").map((row) => row.querySelector("kbd")?.textContent)).toEqual([
      `${mod}1`,
      `${mod}2`,
    ]);
    await userEvent.keyboard(isMac ? "{Meta>}3{/Meta}" : "{Control>}3{/Control}");
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.keyboard(isMac ? "{Meta>}2{/Meta}" : "{Control>}2{/Control}");
    await expect
      .poll(() => onChange.mock.calls)
      .toEqual([[CLAUDE_ID, "claudeAgent", "claude-fable-5-1"]]);
  });

  it("targets favorites, not list rows, with mod+N without favoritePresets", async () => {
    settingsMock.favorites = presets;
    const onChange = vi.fn();
    active = await render(
      <TooltipProvider delay={0}>
        <ProviderInstanceModelPicker
          instanceId={CLAUDE_ID}
          model="claude-fable-5-1"
          lockedInstanceId={null}
          providers={PROVIDERS}
          modelOptionsByInstance={MODELS}
          keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
          onInstanceModelChange={onChange}
        />
      </TooltipProvider>,
    );
    await page.getByRole("button", { name: /Claude Fable 5.1/ }).click();
    // On the Claude chip the first row is Claude Fable; favorite 1 is still the Codex model.
    await page.getByRole("button", { name: "Claude", exact: true }).click();
    await expect.poll(() => groupNames()).toEqual(["Claude models"]);
    await userEvent.keyboard(isMac ? "{Meta>}1{/Meta}" : "{Control>}1{/Control}");
    await expect.poll(() => onChange.mock.calls).toEqual([[CODEX_ID, "codex", "gpt-5.6-sol"]]);
  });
});

describe("ProviderInstanceModelPicker", () => {
  it("preserves capability ordering, including newly reported model versions, instead of alphabetizing names", async () => {
    const models = sortModelsForProviderInstance([
      { slug: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
      { slug: "claude-opus-4-6", name: "Claude Opus 4.6" },
      { slug: "claude-opus-5-5", name: "Claude Opus 5.5" },
      { slug: "claude-fable-5-2", name: "Claude Fable 5.2" },
      { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
      { slug: "claude-opus-5-6", name: "Claude Opus 5.6" },
    ]);
    active = await render(
      <TooltipProvider delay={0}>
        <ProviderInstanceModelPicker
          instanceId={CLAUDE_ID}
          model="claude-opus-5-5"
          lockedInstanceId={null}
          providers={PROVIDERS}
          modelOptionsByInstance={new Map([[CLAUDE_ID, models]])}
          onInstanceModelChange={() => {}}
        />
      </TooltipProvider>,
    );
    await page.getByRole("button", { name: /Claude Opus 5.5/ }).click();
    await expect
      .poll(() =>
        [...document.querySelectorAll("[data-model-picker-row]")].map(
          (row) => row.textContent?.match(/Claude (?:Fable|Opus|Sonnet|Haiku) \d+\.\d+/)?.[0],
        ),
      )
      .toEqual([
        "Claude Fable 5.2",
        "Claude Opus 5.6",
        "Claude Opus 5.5",
        "Claude Opus 4.6",
        "Claude Sonnet 5.5",
        "Claude Haiku 5.5",
      ]);
  });

  it("keeps composition keys in search and uses the short window height", async () => {
    await page.viewport(800, 300);
    const onChange = vi.fn();
    active = await render(
      <TooltipProvider delay={0}>
        <div style={{ position: "fixed", bottom: 80 }}>
          <ProviderInstanceModelPicker
            docked
            instanceId={CODEX_ID}
            model="gpt-5.6-sol"
            lockedInstanceId={null}
            providers={PROVIDERS}
            modelOptionsByInstance={MODELS}
            onInstanceModelChange={onChange}
          />
        </div>
      </TooltipProvider>,
    );
    await page.getByRole("button", { name: /GPT-5.6 Sol/ }).click();
    const search = page.getByPlaceholder("Search models...");
    await search.fill("Sonnet");
    for (const native of [{ isComposing: true }, { keyCode: 229 }]) {
      for (const key of ["Enter", "Escape"]) {
        const event = new KeyboardEvent("keydown", {
          key,
          ...native,
          bubbles: true,
          cancelable: true,
        });
        search.element().dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        await expect.element(search).toBeVisible();
        expect(onChange).not.toHaveBeenCalled();
      }
    }
    const popup = document.querySelector('[data-slot="popover-popup"]')!;
    await expect.poll(() => popup.getBoundingClientRect().height).toBeGreaterThan(250);
    expect(popup.getBoundingClientRect().bottom).toBeLessThanOrEqual(300);
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => onChange.mock.calls.length).toBe(1);
  });
  it("keeps Pi provider/model identities distinct inside an explicit Pi instance", async () => {
    const piId = defaultInstanceIdForDriver(ProviderDriverKind.make("pi"));
    const onChange = vi.fn();
    active = await render(
      <TooltipProvider delay={0}>
        <ProviderInstanceModelPicker
          instanceId={piId}
          model="first/shared"
          lockedInstanceId={null}
          providers={[createTestServerProvider("pi")]}
          modelOptionsByInstance={
            new Map([
              [
                piId,
                [
                  { slug: "first/shared", name: "First shared", subProvider: "first" },
                  { slug: "second/shared", name: "Second shared", subProvider: "second" },
                ],
              ],
            ])
          }
          onInstanceModelChange={onChange}
        />
      </TooltipProvider>,
    );
    await page.getByRole("button", { name: /First shared/ }).click();
    await page.getByPlaceholder("Search models...").fill("Second shared");
    await page.getByText("Second shared", { exact: true }).click();
    expect(onChange).toHaveBeenCalledWith(piId, "pi", "second/shared");
  });
  it("selects Fable 5.1 on the Claude instance from search", async () => {
    const onChange = vi.fn();
    active = await render(
      <TooltipProvider delay={0}>
        <ProviderInstanceModelPicker
          instanceId={CODEX_ID}
          model="gpt-5.6-sol"
          lockedInstanceId={null}
          providers={PROVIDERS}
          modelOptionsByInstance={MODELS}
          onInstanceModelChange={onChange}
        />
      </TooltipProvider>,
    );
    await page.getByRole("button", { name: /GPT-5.6 Sol/ }).click();
    await page.getByPlaceholder("Search models...").fill("Fable 5.1");
    await page.getByText("Claude Fable 5.1", { exact: true }).click();
    expect(onChange).toHaveBeenCalledWith(CLAUDE_ID, "claudeAgent", "claude-fable-5-1");
  });
  it("opens on All, filters by provider chip and scopes search to the chip", async () => {
    active = await render(
      <TooltipProvider delay={0}>
        <ProviderInstanceModelPicker
          instanceId={CODEX_ID}
          model={"gpt-5.6-sol" as ModelSlug}
          lockedInstanceId={null}
          providers={PROVIDERS}
          modelOptionsByInstance={MODELS}
          keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
          onInstanceModelChange={() => {}}
        />
      </TooltipProvider>,
    );

    await page.getByRole("button", { name: /GPT-5.6 Sol/ }).click();
    await expect
      .poll(() => groupNames())
      .toEqual(["Codex models", "Claude models", "Cursor models"]);
    const chips = () =>
      [...document.querySelectorAll<HTMLElement>("[data-model-picker-provider]")].map((chip) => ({
        id: chip.dataset.modelPickerProvider,
        pressed: chip.getAttribute("aria-pressed") === "true",
      }));
    expect(chips()).toEqual([
      { id: "all", pressed: true },
      { id: "favorites", pressed: false },
      { id: `instance:${CODEX_ID}`, pressed: false },
      { id: `instance:${CLAUDE_ID}`, pressed: false },
      { id: `instance:${CURSOR_ID}`, pressed: false },
    ]);

    await page.getByRole("button", { name: "Cursor", exact: true }).click();
    await expect.poll(() => groupNames()).toEqual(["Cursor models"]);

    // Company search still works, but only inside the selected provider.
    await page.getByPlaceholder("Search models...").fill("Anthropic");
    await expect.poll(() => sectionRows("provider").map(rowName)).toEqual(["Claude Opus 4.6"]);

    await page.getByRole("button", { name: "All", exact: true }).click();
    await expect
      .poll(() => sectionRows("provider").map(rowName))
      .toEqual(["Claude Sonnet 4.6", "Claude Fable 5.1", "Claude Opus 4.6"]);

    await page.getByRole("button", { name: "Favorites", exact: true }).click();
    await page.getByPlaceholder("Search models...").fill("");
    await expect.element(page.getByText("No favorite models yet")).toBeVisible();
  });

  it("cycles the chips with the provider shortcuts and wraps around", async () => {
    active = await render(
      <TooltipProvider delay={0}>
        <ProviderInstanceModelPicker
          instanceId={CODEX_ID}
          model={"gpt-5.6-sol" as ModelSlug}
          lockedInstanceId={null}
          providers={PROVIDERS}
          modelOptionsByInstance={MODELS}
          keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
          onInstanceModelChange={() => {}}
        />
      </TooltipProvider>,
    );
    await page.getByRole("button", { name: /GPT-5.6 Sol/ }).click();
    await expect.element(page.getByPlaceholder("Search models...")).toHaveFocus();
    const pressed = () =>
      document.querySelector<HTMLElement>('[data-model-picker-provider][aria-pressed="true"]')
        ?.dataset.modelPickerProvider;
    const isMac = /Mac/u.test(navigator.platform);
    const next = isMac
      ? "{Meta>}{Shift>}{ArrowDown}{/Shift}{/Meta}"
      : "{Control>}{Shift>}{ArrowDown}{/Shift}{/Control}";
    const previous = isMac
      ? "{Meta>}{Shift>}{ArrowUp}{/Shift}{/Meta}"
      : "{Control>}{Shift>}{ArrowUp}{/Shift}{/Control}";

    expect(pressed()).toBe("all");
    await userEvent.keyboard(next);
    await expect.poll(pressed).toBe("favorites");
    await userEvent.keyboard(next);
    await expect.poll(pressed).toBe(`instance:${CODEX_ID}`);
    await userEvent.keyboard(previous);
    await userEvent.keyboard(previous);
    await expect.poll(pressed).toBe("all");
    await userEvent.keyboard(previous);
    await expect.poll(pressed).toBe(`instance:${CURSOR_ID}`);
    await expect.poll(() => groupNames()).toEqual(["Cursor models"]);
  });
});

describe("ProviderInstanceModelPicker recent models", () => {
  function renderPicker(
    props: {
      recordRecents?: boolean;
      modelOptionsByInstance?: ReadonlyMap<
        ProviderInstanceId,
        ReadonlyArray<{ slug: string; name: string; isUnlisted?: boolean }>
      >;
      onInstanceModelChange?: () => unknown;
    } = {},
  ) {
    return render(
      <TooltipProvider delay={0}>
        <ProviderInstanceModelPicker
          instanceId={CODEX_ID}
          model={"gpt-5.6-sol" as ModelSlug}
          lockedInstanceId={null}
          providers={PROVIDERS}
          modelOptionsByInstance={props.modelOptionsByInstance ?? MODELS}
          {...(props.recordRecents === undefined ? {} : { recordRecents: props.recordRecents })}
          onInstanceModelChange={props.onInstanceModelChange ?? (() => {})}
        />
      </TooltipProvider>,
    );
  }

  it("lists resolvable recent picks first, then favorites, then providers", async () => {
    settingsMock.recentModels = [
      { provider: CURSOR_ID, model: "auto" },
      { provider: CLAUDE_ID, model: "claude-retired" },
      { provider: CLAUDE_ID, model: "claude-sonnet-4-6" },
    ];
    settingsMock.favorites = [{ provider: CLAUDE_ID, model: "claude-fable-5-1" }];
    active = await renderPicker();
    await page.getByRole("button", { name: /GPT-5.6 Sol/ }).click();
    await expect
      .poll(() => groupNames())
      .toEqual([
        "Recent models",
        "Favorites models",
        "Codex models",
        "Claude models",
        "Cursor models",
      ]);
    // The retired model no longer resolves, so it is skipped.
    expect(sectionRows("recent").map(rowName)).toEqual(["Auto", "Claude Sonnet 4.6"]);
    expect(sectionRows("favorites").map(rowName)).toEqual(["Claude Fable 5.1"]);
    // Recent and Favorites are hidden while searching.
    await page.getByPlaceholder("Search models...").fill("claude");
    await expect.poll(() => groupNames()).toEqual(["Claude models", "Cursor models"]);
  });

  it("records a pick at the front without duplicating it", async () => {
    settingsMock.recentModels = [
      { provider: CURSOR_ID, model: "auto" },
      { provider: CLAUDE_ID, model: "claude-sonnet-4-6" },
    ];
    active = await renderPicker();
    await page.getByRole("button", { name: /GPT-5.6 Sol/ }).click();
    await page.getByPlaceholder("Search models...").fill("Sonnet");
    await userEvent.keyboard("{Enter}");
    expect(settingsMock.updateSettings).toHaveBeenCalledWith({
      recentModels: [
        { provider: CLAUDE_ID, model: "claude-sonnet-4-6" },
        { provider: CURSOR_ID, model: "auto" },
      ],
    });
  });

  it("does not record when recordRecents is false", async () => {
    active = await renderPicker({ recordRecents: false });
    await page.getByRole("button", { name: /GPT-5.6 Sol/ }).click();
    await page.getByPlaceholder("Search models...").fill("Sonnet");
    await userEvent.keyboard("{Enter}");
    expect(settingsMock.updateSettings).not.toHaveBeenCalled();
  });

  it("does not record a pick the caller refuses", async () => {
    const onChange = vi.fn(() => null);
    active = await renderPicker({ onInstanceModelChange: onChange });
    await page.getByRole("button", { name: /GPT-5.6 Sol/ }).click();
    await page.getByPlaceholder("Search models...").fill("Sonnet");
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(settingsMock.updateSettings).not.toHaveBeenCalled();
  });

  it("records the slug the caller applied", async () => {
    active = await renderPicker({ onInstanceModelChange: () => "claude-fable-5-1" });
    await page.getByRole("button", { name: /GPT-5.6 Sol/ }).click();
    await page.getByPlaceholder("Search models...").fill("Sonnet");
    await userEvent.keyboard("{Enter}");
    expect(settingsMock.updateSettings).toHaveBeenCalledWith({
      recentModels: [{ provider: CLAUDE_ID, model: "claude-fable-5-1" }],
    });
  });

  it("hides a recent model the catalog unlisted and drops it on the next pick", async () => {
    settingsMock.recentModels = [
      { provider: CLAUDE_ID, model: "claude-sonnet-4-6" },
      { provider: CURSOR_ID, model: "auto" },
      { provider: CLAUDE_ID, model: "claude-gone" },
    ];
    const models = new Map<
      ProviderInstanceId,
      ReadonlyArray<{ slug: string; name: string; isUnlisted?: boolean }>
    >(MODELS);
    models.set(CLAUDE_ID, [
      { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", isUnlisted: true },
      { slug: "claude-fable-5-1", name: "Claude Fable 5.1" },
    ]);
    active = await renderPicker({ modelOptionsByInstance: models });
    await page.getByRole("button", { name: /GPT-5.6 Sol/ }).click();
    await expect.poll(() => sectionRows("recent").map(rowName)).toEqual(["Auto"]);
    await page.getByPlaceholder("Search models...").fill("Fable");
    await userEvent.keyboard("{Enter}");
    // The model that left the catalog stops taking a slot; the unlisted one is still offered.
    expect(settingsMock.updateSettings).toHaveBeenCalledWith({
      recentModels: [
        { provider: CLAUDE_ID, model: "claude-fable-5-1" },
        { provider: CLAUDE_ID, model: "claude-sonnet-4-6" },
        { provider: CURSOR_ID, model: "auto" },
      ],
    });
  });
});

describe("ProviderInstanceModelPicker controlled open", () => {
  it("starts fresh when reopened through the controlled open prop", async () => {
    const picker = (open: boolean) => (
      <TooltipProvider delay={0}>
        <ProviderInstanceModelPicker
          open={open}
          instanceId={CODEX_ID}
          model={"gpt-5.6-sol" as ModelSlug}
          lockedInstanceId={null}
          providers={PROVIDERS}
          modelOptionsByInstance={MODELS}
          onInstanceModelChange={() => {}}
        />
      </TooltipProvider>
    );
    active = await render(picker(true));
    await page.getByRole("button", { name: "Cursor", exact: true }).click();
    await page.getByPlaceholder("Search models...").fill("auto");
    await expect.poll(() => groupNames()).toEqual(["Cursor models"]);

    // `modelPicker.toggle` closes and reopens through `open`, never through `onOpenChange`.
    await active.rerender(picker(false));
    await expect.element(page.getByPlaceholder("Search models...")).not.toBeInTheDocument();
    await active.rerender(picker(true));
    await expect.element(page.getByPlaceholder("Search models...")).toHaveValue("");
    await expect
      .poll(() => groupNames())
      .toEqual(["Codex models", "Claude models", "Cursor models"]);
    expect(
      document.querySelector('[data-model-picker-provider][aria-pressed="true"]')?.textContent,
    ).toBe("All");
  });
});

describe("ProviderInstanceModelPicker legacy models", () => {
  const legacyModels = new Map([
    [
      CODEX_ID,
      [
        { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
        { slug: "gpt-5-sol", name: "GPT-5 Sol", isLegacy: true },
        { slug: "gpt-5-luna", name: "GPT-5 Luna", isLegacy: true },
      ],
    ],
  ]);

  function renderPicker(model: string) {
    return render(
      <TooltipProvider delay={0}>
        <ProviderInstanceModelPicker
          instanceId={CODEX_ID}
          model={model as ModelSlug}
          lockedInstanceId={null}
          providers={PROVIDERS}
          modelOptionsByInstance={legacyModels}
          onInstanceModelChange={() => {}}
        />
      </TooltipProvider>,
    );
  }

  const disclosure = () => document.querySelector<HTMLElement>("[data-model-picker-legacy]");

  it("collapses legacy models behind a disclosure that expands by click or keyboard", async () => {
    active = await renderPicker("gpt-5.6-sol");
    await page.getByRole("button", { name: /GPT-5.6 Sol/ }).click();
    await expect.poll(() => sectionRows("provider").map(rowName)).toEqual(["GPT-5.6 Sol"]);
    expect(disclosure()?.textContent).toBe("Legacy2");
    expect(disclosure()?.getAttribute("aria-expanded")).toBe("false");

    disclosure()!.click();
    await expect
      .poll(() => sectionRows("provider").map(rowName))
      .toEqual(["GPT-5.6 Sol", "GPT-5 Sol", "GPT-5 Luna"]);

    // ArrowDown reaches the disclosure; ArrowLeft collapses and ArrowRight expands it.
    const input = page.getByPlaceholder("Search models...").element() as HTMLElement;
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(disclosure()?.hasAttribute("data-highlighted")).toBe(true));
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }),
    );
    await expect.poll(() => sectionRows("provider").length).toBe(1);
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await expect.poll(() => sectionRows("provider").length).toBe(3);
  });

  it("keeps the disclosure open while a legacy model is active", async () => {
    active = await renderPicker("gpt-5-luna");
    await page.getByRole("button", { name: /GPT-5 Luna/ }).click();
    await expect
      .poll(() => sectionRows("provider").map(rowName))
      .toEqual(["GPT-5.6 Sol", "GPT-5 Sol", "GPT-5 Luna"]);
    expect(disclosure()?.getAttribute("aria-expanded")).toBe("true");
    // Held open, so it offers no toggle and the arrow keys skip it.
    expect((disclosure() as HTMLButtonElement).disabled).toBe(true);
    const input = page.getByPlaceholder("Search models...").element() as HTMLElement;
    for (let index = 0; index < 5; index += 1)
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
    await vi.waitFor(() =>
      expect(
        document.querySelector("[data-model-picker-row][data-highlighted]")?.textContent,
      ).toContain("GPT-5 Luna"),
    );
    expect(disclosure()?.hasAttribute("data-highlighted")).toBe(false);
  });

  it("shows legacy matches inline while searching", async () => {
    active = await renderPicker("gpt-5.6-sol");
    await page.getByRole("button", { name: /GPT-5.6 Sol/ }).click();
    await page.getByPlaceholder("Search models...").fill("sol");
    await expect
      .poll(() => sectionRows("provider").map(rowName))
      .toEqual(["GPT-5.6 Sol", "GPT-5 Sol"]);
    expect(disclosure()).toBeNull();
  });
});

it("keeps selected and fan-out unlisted models visible and reacts while open", async () => {
  const onToggleModel = vi.fn();
  const models = new Map([
    [
      CODEX_ID,
      [
        { slug: "listed", name: "Listed Model" },
        { slug: "retired", name: "Retired Model", isUnlisted: true },
        { slug: "fanout", name: "Fanout Model", isUnlisted: true },
      ],
    ],
  ]);
  const picker = (
    model: string,
    selectedModels: ReadonlyArray<{ instanceId: ProviderInstanceId; model: string }> = [],
  ) => (
    <TooltipProvider delay={0}>
      <ProviderInstanceModelPicker
        open
        instanceId={CODEX_ID}
        model={model}
        lockedInstanceId={CODEX_ID}
        providers={PROVIDERS}
        modelOptionsByInstance={new Map(models)}
        selectedModels={selectedModels}
        onToggleModel={onToggleModel}
        onInstanceModelChange={() => {}}
      />
    </TooltipProvider>
  );
  active = await render(picker("listed"));
  await expect
    .element(
      page.getByRole("group", { name: /models$/ }).getByText("Listed Model", { exact: true }),
    )
    .toBeVisible();
  await expect.element(page.getByText("Retired Model", { exact: true })).not.toBeInTheDocument();
  await active.rerender(picker("retired", [{ instanceId: CODEX_ID, model: "fanout" }]));
  await expect.element(page.getByText("Retired Model", { exact: true }).last()).toBeVisible();
  await expect.element(page.getByText("Fanout Model", { exact: true })).toBeVisible();
  await page.getByText("Fanout Model", { exact: true }).click({ modifiers: ["Shift"] });
  expect(onToggleModel).toHaveBeenCalledWith(CODEX_ID, "codex", "fanout");
  // Fan-out toggles are not picks, so Recent stays untouched.
  expect(settingsMock.updateSettings).not.toHaveBeenCalled();
  await active.rerender(picker("listed"));
  await expect.element(page.getByText("Fanout Model", { exact: true })).not.toBeInTheDocument();
  models.set(CODEX_ID, [
    { slug: "listed", name: "Listed Model" },
    { slug: "retired", name: "Retired Model", isUnlisted: false },
  ]);
  await active.rerender(picker("listed"));
  await expect.element(page.getByText("Retired Model", { exact: true })).toBeVisible();
});

it("keeps an instance blocked by the caller as a chip with its rows disabled", async () => {
  const isMac = /Mac/u.test(navigator.platform);
  const onChange = vi.fn();
  const reason = "Not allowed for this workflow stage.";
  active = await render(
    <TooltipProvider delay={0}>
      <ProviderInstanceModelPicker
        instanceId={CODEX_ID}
        model={"gpt-5.6-sol" as ModelSlug}
        lockedInstanceId={null}
        providers={PROVIDERS}
        modelOptionsByInstance={MODELS}
        keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
        instanceUnavailableReason={(instance) =>
          instance.instanceId === CLAUDE_ID ? reason : null
        }
        onInstanceModelChange={onChange}
      />
    </TooltipProvider>,
  );
  await page.getByRole("button", { name: /GPT-5.6 Sol/ }).click();
  await page.getByRole("button", { name: "Claude", exact: true }).click();

  const claudeRow = () =>
    [...document.querySelectorAll<HTMLElement>("[data-model-picker-row]")].find((row) =>
      row.textContent?.includes("Claude Sonnet 4.6"),
    );
  await expect.poll(() => claudeRow()?.title ?? "").toBe(reason);
  // Shown in place of the slug, so it is visible without hovering and read with the row.
  expect(claudeRow()!.querySelector("[data-model-picker-select]")?.textContent).toContain(reason);
  const select = claudeRow()!.querySelector<HTMLButtonElement>("[data-model-picker-select]")!;
  expect(select.disabled).toBe(true);

  select.click();
  await userEvent.keyboard("{Enter}");
  await userEvent.keyboard(isMac ? "{Meta>}1{/Meta}" : "{Control>}1{/Control}");
  expect(onChange).not.toHaveBeenCalled();
});

describe("ProviderInstanceModelPicker keyboard navigation", () => {
  function pressKey(input: HTMLElement, key: string) {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  }

  it("moves through a long list with the arrow keys and picks the highlighted row", async () => {
    const onChange = vi.fn();
    const models = new Map([
      [
        CODEX_ID,
        Array.from({ length: 160 }, (_, index) => ({
          slug: `codex-long-${index}`,
          name: `Codex Long ${index}`,
        })),
      ],
    ]);
    active = await render(
      <TooltipProvider delay={0}>
        <ProviderInstanceModelPicker
          instanceId={CODEX_ID}
          model={"codex-long-0" as ModelSlug}
          lockedInstanceId={null}
          providers={PROVIDERS}
          modelOptionsByInstance={models}
          onInstanceModelChange={onChange}
        />
      </TooltipProvider>,
    );
    await page.getByRole("button", { name: /Codex Long 0/ }).click();
    await expect.element(page.getByPlaceholder("Search models...")).toBeVisible();
    const input = page.getByPlaceholder("Search models...").element() as HTMLElement;

    for (let index = 0; index < 200; index += 1) pressKey(input, "ArrowDown");
    pressKey(input, "ArrowUp");

    const highlighted = () =>
      document.querySelector<HTMLElement>("[data-model-picker-row][data-highlighted]");
    await vi.waitFor(() => expect(highlighted()?.textContent).toContain("Codex Long 158"));
    await vi.waitFor(() => {
      const row = highlighted()!.getBoundingClientRect();
      const list = highlighted()!.closest(".overflow-y-auto")!.getBoundingClientRect();
      expect(row.top).toBeGreaterThanOrEqual(list.top - 1);
      expect(row.bottom).toBeLessThanOrEqual(list.bottom + 1);
    });

    pressKey(input, "Enter");
    expect(onChange).toHaveBeenCalledWith(CODEX_ID, "codex", "codex-long-158");
  });

  it("skips rows the caller blocks, so Enter picks the first selectable match", async () => {
    const onChange = vi.fn();
    active = await render(
      <TooltipProvider delay={0}>
        <ProviderInstanceModelPicker
          instanceId={CODEX_ID}
          model={"gpt-5.6-sol" as ModelSlug}
          lockedInstanceId={null}
          providers={PROVIDERS}
          modelOptionsByInstance={MODELS}
          instanceUnavailableReason={(instance) =>
            instance.instanceId === CLAUDE_ID ? "Not allowed for this workflow stage." : null
          }
          onInstanceModelChange={onChange}
        />
      </TooltipProvider>,
    );
    await page.getByRole("button", { name: /GPT-5.6 Sol/ }).click();
    await page.getByPlaceholder("Search models...").fill("claude");
    const input = page.getByPlaceholder("Search models...").element() as HTMLElement;

    await vi.waitFor(() =>
      expect(
        document.querySelector("[data-model-picker-row][data-highlighted]")?.textContent,
      ).toContain("Claude Opus 4.6"),
    );
    pressKey(input, "ArrowDown");
    pressKey(input, "Enter");
    expect(onChange).toHaveBeenCalledWith(CURSOR_ID, "cursor", "claude-opus-4-6");
  });
});

it("shows the bare model, not another provider's icon, when its instance is gone", async () => {
  active = await render(
    <TooltipProvider delay={0}>
      <ProviderInstanceModelPicker
        instanceId={defaultInstanceIdForDriver(ProviderDriverKind.make("antigravity"))}
        model={"gemini-4-neon" as ModelSlug}
        lockedInstanceId={null}
        providers={PROVIDERS}
        modelOptionsByInstance={MODELS}
        onInstanceModelChange={vi.fn()}
      />
    </TooltipProvider>,
  );
  const trigger = page.getByRole("button", { name: /gemini-4-neon/ }).element();
  // Only the chevron; no driver icon.
  expect(trigger.querySelectorAll("svg")).toHaveLength(1);
});
