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
