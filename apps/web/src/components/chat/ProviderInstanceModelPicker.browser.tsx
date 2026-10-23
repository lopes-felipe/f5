import "../../index.css";

import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ModelSlug,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { createTestServerProvider } from "../../testServerProvider";
import { TooltipProvider } from "../ui/tooltip";
import { ProviderInstanceModelPicker } from "./ProviderInstanceModelPicker";

vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => ({ favorites: [] }),
  useUpdateSettings: () => ({ updateSettings: vi.fn() }),
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
});

describe("ProviderInstanceModelPicker", () => {
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
