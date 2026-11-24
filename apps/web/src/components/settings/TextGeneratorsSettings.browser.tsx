import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  ProviderInstanceId,
  type TextGeneratorConfig,
} from "@t3tools/contracts";
import { TextGeneratorsSettings } from "./TextGeneratorsSettings";
const mocks = vi.hoisted(() => ({ update: vi.fn().mockResolvedValue(undefined) }));
let settings = DEFAULT_UNIFIED_SETTINGS;
vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => settings,
  useUpdateSettings: () => ({ updateSettings: mocks.update }),
}));

const savedGenerator: TextGeneratorConfig = {
  kind: "openaiCompatible",
  label: "Saved",
  baseUrl: "https://example.test/v1",
  apiKey: "",
  apiKeyRedacted: true,
  enabled: true,
  models: ["model"],
};

function withSavedGenerator(overrides: Partial<typeof DEFAULT_UNIFIED_SETTINGS> = {}) {
  settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    textGenerators: { [ProviderInstanceId.make("textgen_test")]: savedGenerator },
    ...overrides,
  };
}

afterEach(() => {
  settings = DEFAULT_UNIFIED_SETTINGS;
  mocks.update.mockClear();
});

it("shows an empty state when no generators exist", async () => {
  const screen = await render(<TextGeneratorsSettings />);
  try {
    await expect.element(page.getByText("No text generators yet.", { exact: false })).toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it("saves an API endpoint and multiple models from the add dialog", async () => {
  const screen = await render(<TextGeneratorsSettings />);
  try {
    await page.getByRole("button", { name: "Add text generator", exact: true }).click();
    await page.getByRole("combobox", { name: "Text generator preset" }).selectOptions("Ollama");
    await page.getByRole("textbox", { name: "Text generator model IDs" }).fill("llama, qwen");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    expect(mocks.update).toHaveBeenCalledWith({
      textGenerators: expect.objectContaining({
        [Object.keys(mocks.update.mock.calls[0]![0].textGenerators)[0]!]: expect.objectContaining({
          label: "Ollama",
          baseUrl: "http://localhost:11434/v1",
          models: ["llama", "qwen"],
        }),
      }),
    });
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

it("keeps the stored key when a typed replacement is cleared", async () => {
  withSavedGenerator();
  const screen = await render(<TextGeneratorsSettings />);
  try {
    await page.getByRole("button", { name: "Edit Saved", exact: true }).click();
    await page.getByLabelText("Text generator API key", { exact: true }).fill("replacement");
    await page.getByLabelText("Text generator API key", { exact: true }).fill("");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect(mocks.update).toHaveBeenLastCalledWith({
      textGenerators: {
        textgen_test: expect.objectContaining({ apiKey: "", apiKeyRedacted: true }),
      },
    });
  } finally {
    await screen.unmount();
  }
});

it("toggles a generator off from its row", async () => {
  withSavedGenerator();
  const screen = await render(<TextGeneratorsSettings />);
  try {
    await page.getByRole("switch", { name: "Enable Saved" }).click();
    expect(mocks.update).toHaveBeenLastCalledWith({
      textGenerators: { textgen_test: expect.objectContaining({ enabled: false }) },
    });
  } finally {
    await screen.unmount();
  }
});

it("resets the text generation selection when the default generator is removed", async () => {
  withSavedGenerator({
    textGenerationModelSelection: {
      instanceId: ProviderInstanceId.make("textgen_test"),
      model: "model",
    },
  });
  const screen = await render(<TextGeneratorsSettings />);
  try {
    await expect.element(page.getByText("Default", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Remove Saved", exact: true }).click();
    expect(mocks.update).toHaveBeenLastCalledWith({
      textGenerators: {},
      textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
    });
  } finally {
    await screen.unmount();
  }
});
