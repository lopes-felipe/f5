import "../../index.css";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { TextGeneratorsSettings } from "./TextGeneratorsSettings";
const mocks = vi.hoisted(() => ({ update: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => DEFAULT_UNIFIED_SETTINGS,
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
