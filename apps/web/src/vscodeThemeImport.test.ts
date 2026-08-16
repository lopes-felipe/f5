import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { importThemeFile, importVsCodeThemeDocument } from "./vscodeThemeImport";

describe("VS Code theme import", () => {
  it("maps workbench and token colors without evaluating theme content", () => {
    const theme = importVsCodeThemeDocument({
      name: "Blue Night",
      type: "dark",
      colors: {
        "editor.background": "#10131a",
        "editor.foreground": "#e9edf5",
        "button.background": "#3b82f6",
      },
      tokenColors: [
        { scope: ["comment"], settings: { foreground: "#778099" } },
        { scope: "keyword.control", settings: { foreground: "#8b5cf6" } },
      ],
    });

    expect(theme.name).toBe("Blue Night");
    expect(theme.overrides?.dark).toMatchObject({
      background: "#10131a",
      foreground: "#e9edf5",
      primary: "#8b5cf6",
      "muted-foreground": "#778099",
    });
    expect(theme.overrides?.light).toBeUndefined();
  });

  it("imports the declared theme entry from a bounded VSIX", async () => {
    const archive = zipSync({
      "extension/package.json": strToU8(
        JSON.stringify({
          contributes: { themes: [{ label: "Archive Theme", path: "themes/archive.json" }] },
        }),
      ),
      "extension/themes/archive.json": strToU8(
        JSON.stringify({
          type: "light",
          colors: { "editor.background": "#ffffff", "editor.foreground": "#202020" },
        }),
      ),
      "extension/ignored.txt": strToU8("not extracted"),
    });
    const file = new File([archive], "archive.vsix", { type: "application/zip" });

    const imported = await importThemeFile(file);

    expect(imported.name).toBe("Archive Theme");
    expect(imported.overrides?.light?.background).toBe("#ffffff");
  });

  it("rejects traversal and oversized expanded theme entries", async () => {
    const unsafe = zipSync({
      "extension/package.json": strToU8(
        JSON.stringify({ contributes: { themes: [{ path: "../secret.json" }] } }),
      ),
    });
    await expect(importThemeFile(new File([unsafe], "unsafe.vsix"))).rejects.toThrow("unsafe");

    const oversized = zipSync({
      "extension/package.json": strToU8(
        JSON.stringify({ contributes: { themes: [{ path: "themes/huge.json" }] } }),
      ),
      "extension/themes/huge.json": new Uint8Array(1024 * 1024 + 1),
    });
    await expect(importThemeFile(new File([oversized], "huge.vsix"))).rejects.toThrow("size limit");
  });
});
