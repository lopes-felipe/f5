import { describe, expect, it } from "vitest";

import { addCustomTheme, removeCustomTheme, updateCustomTheme } from "./themeEditorStore";
import { createCustomThemeDefinition } from "./themePalette";

const customTheme = createCustomThemeDefinition({
  id: "custom-test",
  name: "Test",
  parameters: { baseHue: 210, chroma: 0.14, contrast: 1 },
});

describe("custom theme mutations", () => {
  it("preserves invalid raw entries while adding, updating, and removing valid themes", () => {
    const invalid = { version: 99, raw: "preserve" };
    const added = addCustomTheme([invalid], customTheme);
    expect(added).toEqual([invalid, customTheme]);

    const updatedTheme = { ...customTheme, name: "Updated" };
    const updated = updateCustomTheme(added, updatedTheme);
    expect(updated).toEqual([invalid, updatedTheme]);
    expect(removeCustomTheme(updated, customTheme.id)).toEqual([invalid]);
  });

  it("rejects reserved theme ids", () => {
    expect(() => addCustomTheme([], { ...customTheme, id: "f5-default" })).toThrow("reserved");
  });
});
