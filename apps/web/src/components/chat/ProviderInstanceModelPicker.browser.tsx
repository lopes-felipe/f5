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
  updateSettings: vi.fn(),
}));

vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => ({ favorites: settingsMock.favorites }),
  useUpdateSettings: () => ({ updateSettings: settingsMock.updateSettings }),
}));

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
      [...document.querySelectorAll<HTMLElement>("[data-model-picker-row]")].map((row) => ({
        effort: row.querySelector("[data-model-picker-preset-effort]")?.textContent ?? null,
        active: row.textContent?.includes("Active") ?? false,
        jump: row.querySelector("kbd")?.textContent ?? null,
      }));
    await expect.poll(() => rows().length).toBe(3);
    const mod = isMac ? "⌘" : "Ctrl+";
    expect(rows()).toEqual([
      { effort: null, active: false, jump: `${mod}1` },
      { effort: "high", active: false, jump: `${mod}2` },
      { effort: "xhigh", active: true, jump: `${mod}3` },
    ]);
  });

  it("picks a preset row with mod+N and passes its preset", async () => {
    const onChange = await renderPicker();
    await userEvent.keyboard(isMac ? "{Meta>}3{/Meta}" : "{Control>}3{/Control}");
    await expect
      .poll(() => onChange.mock.calls)
      .toEqual([[CLAUDE_ID, "claudeAgent", "claude-fable-5-1", presets[2]]]);
  });

  it("keeps favorite numbers in a locked thread so mod+N matches ctrl+N", async () => {
    const onChange = await renderPicker(vi.fn(), null, CLAUDE_ID);
    const jumps = () =>
      [...document.querySelectorAll<HTMLElement>("[data-model-picker-row]")].map(
        (row) => row.querySelector("kbd")?.textContent ?? null,
      );
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
    await expect.poll(() => document.querySelectorAll("[data-model-picker-row]").length).toBe(2);
    expect(document.querySelector("[data-model-picker-preset-effort]")).toBeNull();
    await userEvent.keyboard(isMac ? "{Meta>}2{/Meta}" : "{Control>}2{/Control}");
    await expect
      .poll(() => onChange.mock.calls)
      .toEqual([[CLAUDE_ID, "claudeAgent", "claude-fable-5-1"]]);
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
  it("restores provider-sidebar browsing and keeps cross-provider lab search", async () => {
    active = await render(
      <TooltipProvider delay={0}>
        <ProviderInstanceModelPicker
          instanceId={CODEX_ID}
          model={"gpt-5.6-sol" as ModelSlug}
          lockedInstanceId={null}
          providers={PROVIDERS}
          modelOptionsByInstance={MODELS}
          onInstanceModelChange={() => {}}
        />
      </TooltipProvider>,
    );

    await page.getByRole("button", { name: /GPT-5.6 Sol/ }).click();
    await expect.element(page.getByRole("group", { name: "OpenAI models" })).toBeInTheDocument();
    expect(page.getByRole("group", { name: "Anthropic models" }).query()).toBeNull();
    await expect
      .element(page.getByRole("button", { name: "Codex", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Claude", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Cursor", exact: true }))
      .toBeInTheDocument();

    await page.getByRole("button", { name: "Cursor", exact: true }).click();
    await expect.element(page.getByRole("group", { name: "Anthropic models" })).toBeInTheDocument();
    await expect.element(page.getByRole("group", { name: "Cursor models" })).toBeInTheDocument();
    expect(page.getByRole("group", { name: "OpenAI models" }).query()).toBeNull();

    await page.getByPlaceholder("Search models...").fill("Anthropic");

    await expect.element(page.getByText("Claude Sonnet 4.6")).toBeInTheDocument();
    await expect.element(page.getByText("Claude Opus 4.6")).toBeInTheDocument();
    expect(page.getByRole("group", { name: "OpenAI models" }).query()).toBeNull();
    expect(page.getByRole("group", { name: "Cursor models" }).query()).toBeNull();
    expect(page.getByRole("button", { name: "Cursor", exact: true }).query()).toBeNull();
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
  await active.rerender(picker("listed"));
  await expect.element(page.getByText("Fanout Model", { exact: true })).not.toBeInTheDocument();
  models.set(CODEX_ID, [
    { slug: "listed", name: "Listed Model" },
    { slug: "retired", name: "Retired Model", isUnlisted: false },
  ]);
  await active.rerender(picker("listed"));
  await expect.element(page.getByText("Retired Model", { exact: true })).toBeVisible();
});
