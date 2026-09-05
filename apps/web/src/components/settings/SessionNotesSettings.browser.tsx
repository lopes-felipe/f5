import "../../index.css";
import {
  DEFAULT_UNIFIED_SETTINGS,
  ProviderInstanceId,
  type ModelSelection,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { createTestServerProvider } from "../../testServerProvider";
import { TooltipProvider } from "../ui/tooltip";
import { SessionNotesSettings } from "./SessionNotesSettings";

const state = vi.hoisted(() => ({
  selection: undefined as ModelSelection | undefined,
  update: vi.fn(),
}));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => ({ ...DEFAULT_UNIFIED_SETTINGS, sessionNotesModelSelection: state.selection }),
  useUpdateSettings: () => ({ updateSettings: state.update }),
}));
const caps = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      type: "select",
      label: "Reasoning",
      currentValue: "medium",
      options: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium", isDefault: true },
      ],
    },
  ],
});
const providers = [
  createTestServerProvider("codex", {
    models: [{ slug: "gpt-5.6-luna", name: "GPT-5.6 Luna", capabilities: caps, isCustom: false }],
  }),
  createTestServerProvider("claudeAgent", {
    models: [
      {
        slug: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        capabilities: createModelCapabilities({ optionDescriptors: [] }),
        isCustom: false,
      },
    ],
  }),
  createTestServerProvider("cursor"),
];
let active: Awaited<ReturnType<typeof render>> | undefined;
beforeEach(() => {
  state.selection = DEFAULT_UNIFIED_SETTINGS.sessionNotesModelSelection;
  state.update.mockReset().mockImplementation(async (patch) => {
    state.selection = patch.sessionNotesModelSelection;
  });
});
afterEach(async () => {
  await active?.unmount();
  active = undefined;
});
const mount = async () => {
  active = await render(
    <TooltipProvider>
      <SessionNotesSettings providers={providers} />
    </TooltipProvider>,
  );
};

it("saves reasoning options and preserves them on remount", async () => {
  await mount();
  await page.getByRole("button", { name: "Low", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Medium (default)", exact: true }).click();
  await expect.poll(() => state.update.mock.calls.length).toBe(1);
  expect(state.selection?.options).toContainEqual({ id: "reasoningEffort", value: "medium" });
  await active?.unmount();
  await mount();
  await expect
    .element(page.getByRole("button", { name: "Medium", exact: true }))
    .toBeInTheDocument();
});

it("offers supported providers and clears options when switching", async () => {
  await mount();
  await page.getByRole("button", { name: /GPT-5.6 Luna/ }).click();
  expect(page.getByRole("button", { name: "Cursor", exact: true }).query()).toBeNull();
  await page.getByRole("button", { name: "Claude", exact: true }).click();
  await page.getByText("Claude Sonnet 4.6", { exact: true }).click();
  await expect
    .poll(() => state.selection)
    .toEqual({ instanceId: "claudeAgent", model: "claude-sonnet-4-6" });
});

it("shows an unavailable selection without silently changing it", async () => {
  state.selection = { instanceId: ProviderInstanceId.make("missing"), model: "gpt-5.6-luna" };
  await mount();
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("No fallback model will be used");
  expect(state.update).not.toHaveBeenCalled();
});
