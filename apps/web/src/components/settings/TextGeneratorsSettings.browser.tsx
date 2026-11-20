import "../../index.css";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { DEFAULT_UNIFIED_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import { TextGeneratorsSettings } from "./TextGeneratorsSettings";
const mocks = vi.hoisted(() => ({ update: vi.fn().mockResolvedValue(undefined) }));
let settings = DEFAULT_UNIFIED_SETTINGS;
vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => settings,
  useUpdateSettings: () => ({ updateSettings: mocks.update }),
}));
it("saves an API endpoint and multiple models", async () => {
  const screen = await render(<TextGeneratorsSettings />);
  try {
    await page.getByRole("combobox", { name: "Text generator preset" }).selectOptions("Ollama");
    await page.getByRole("textbox", { name: "Text generator model IDs" }).fill("llama, qwen");
    await page.getByRole("button", { name: "Add text generator", exact: true }).click();
    expect(mocks.update).toHaveBeenCalledWith({
      textGenerators: expect.objectContaining({
        [Object.keys(mocks.update.mock.calls[0]![0].textGenerators)[0]!]: expect.objectContaining({
          label: "Ollama",
          baseUrl: "http://localhost:11434/v1",
          models: ["llama", "qwen"],
        }),
      }),
    });
  } finally {
    await screen.unmount();
  }
});

it("keeps the stored key when a typed replacement is cleared", async () => {
  settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    textGenerators: {
      [ProviderInstanceId.make("textgen_test")]: {
        kind: "openaiCompatible",
        label: "Saved",
        baseUrl: "https://example.test/v1",
        apiKey: "",
        apiKeyRedacted: true,
        enabled: true,
        models: ["model"],
      },
    },
  };
  const screen = await render(<TextGeneratorsSettings />);
  try {
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByLabelText("Text generator API key", { exact: true }).fill("replacement");
    await page.getByLabelText("Text generator API key", { exact: true }).fill("");
    await page.getByRole("button", { name: "Save text generator", exact: true }).click();
    expect(mocks.update).toHaveBeenLastCalledWith({
      textGenerators: {
        textgen_test: expect.objectContaining({ apiKey: "", apiKeyRedacted: true }),
      },
    });
  } finally {
    await screen.unmount();
    settings = DEFAULT_UNIFIED_SETTINGS;
  }
});
