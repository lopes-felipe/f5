import { wcagContrast } from "culori";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { importThemeFile, importVsCodeThemeDocument } from "./vscodeThemeImport";
import { resolveThemePalette } from "./themePalette";

describe("VS Code theme import", () => {
  it("keeps generated fallback muted and placeholder text dimmer than entered text", () => {
    const definition = importVsCodeThemeDocument({
      name: "Dark fallback",
      type: "dark",
      colors: { "editor.background": "#1e1e2e", "editor.foreground": "#cdd6f4" },
    });
    const colors = resolveThemePalette(definition.id, [definition]).dark;
    const mutedContrast = wcagContrast(colors["muted-foreground"], colors.background);
    expect(mutedContrast).toBeGreaterThanOrEqual(4.6);
    expect(mutedContrast).toBeLessThan(wcagContrast(colors.foreground, colors.background));
  });
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

  describe("control colors", () => {
    const resolve = (definition: ReturnType<typeof importVsCodeThemeDocument>) =>
      resolveThemePalette(definition.id, [definition]);
    const separation = (first: string, second: string) => wcagContrast(first, second);

    it("prefers a visible input background over a transparent border", () => {
      const catppuccin = importVsCodeThemeDocument({
        name: "Catppuccin Mocha",
        type: "dark",
        colors: {
          "editor.background": "#1e1e2e",
          "input.border": "#00000000",
          "input.background": "#313244",
        },
      });
      expect(catppuccin.overrides?.dark?.input).toBe("#313244");
    });

    it("skips an input background that matches the editor for the input border", () => {
      const theme = importVsCodeThemeDocument({
        name: "Flat input",
        type: "dark",
        colors: {
          "editor.background": "#1e1e2e",
          "input.background": "#1e1e2e",
          "input.border": "#585b70",
        },
      });
      expect(theme.overrides?.dark?.input).toBe("#585b70");
    });

    it("keeps unchecked switch tracks distinct from the checked track", () => {
      const gruvbox = importVsCodeThemeDocument({
        name: "Gruvbox Light Soft",
        type: "light",
        colors: {
          "editor.background": "#f2e5bc",
          "button.background": "#45858880",
          "input.background": "#45858880",
          "input.border": "#928374",
        },
      });
      const colors = resolve(gruvbox).light;
      expect(separation(colors.input, colors.primary)).toBeGreaterThanOrEqual(1.1);
      expect(separation(colors.input, colors.background)).toBeGreaterThanOrEqual(1.1);
    });

    it("replaces a generated input that a button reuses", () => {
      const theme = importVsCodeThemeDocument({
        name: "Derived input collision",
        type: "dark",
        colors: {
          "editor.background": "#1e1e2e",
          focusBorder: "#89b4fa",
          "button.background": "#525661",
        },
      });
      const colors = resolve(theme).dark;
      expect(colors.primary).toBe("#525661");
      expect(separation(colors.input, colors.background)).toBeGreaterThanOrEqual(1.1);
      expect(separation(colors.input, colors.primary)).toBeGreaterThanOrEqual(1.1);
    });

    it("skips a transparent focus border for a visible accent key", () => {
      const vitesse = importVsCodeThemeDocument({
        name: "Vitesse Dark",
        type: "dark",
        colors: {
          "editor.background": "#121212",
          focusBorder: "#00000000",
          "button.background": "#4d9375",
        },
      });
      expect(vitesse.overrides?.dark?.ring).toBe("#4d9375");
      expect(vitesse.overrides?.dark?.primary).toBe("#4d9375");
    });

    it("keeps focus visible against an explicit raised surface", () => {
      const theme = importVsCodeThemeDocument({
        name: "Raised focus",
        type: "dark",
        colors: {
          "editor.background": "#000000",
          focusBorder: "#111111",
          "editorWidget.background": "#111111",
          "button.background": "#4d9375",
        },
      });
      expect(theme.overrides?.dark?.ring).toBe("#4d9375");
    });

    it("falls back to a visible ring when generated and authored accents both blend in", () => {
      const theme = importVsCodeThemeDocument({
        name: "Raised fallback focus",
        type: "dark",
        colors: {
          "editor.background": "#121212",
          "editorWidget.background": "#346bf1",
          focusBorder: "#121212",
        },
      });
      const colors = resolve(theme).dark;
      expect(separation(colors.ring, colors.background)).toBeGreaterThanOrEqual(1.1);
      expect(separation(colors.ring, colors.popover)).toBeGreaterThanOrEqual(1.1);
      expect(separation(colors.primary, colors.background)).toBeGreaterThanOrEqual(1.1);
      expect(separation(colors.primary, colors.popover)).toBeGreaterThanOrEqual(1.1);
    });

    it("skips a transparent button background for the checked track", () => {
      const theme = importVsCodeThemeDocument({
        name: "Transparent button",
        type: "dark",
        colors: {
          "editor.background": "#121212",
          focusBorder: "#4d9375",
          "button.background": "#00000000",
        },
      });
      const colors = resolve(theme).dark;
      expect(theme.overrides?.dark?.ring).toBe("#4d9375");
      expect(separation(colors.primary, colors.background)).toBeGreaterThanOrEqual(1.1);
    });

    it("skips a button background that matches the raised surface", () => {
      const theme = importVsCodeThemeDocument({
        name: "Raised button",
        type: "dark",
        colors: {
          "editor.background": "#121212",
          focusBorder: "#4d9375",
          "editorWidget.background": "#2a2d3a",
          "button.background": "#2a2d3a",
        },
      });
      const colors = resolve(theme).dark;
      expect(theme.overrides?.dark?.primary).not.toBe("#2a2d3a");
      expect(separation(colors.primary, colors.popover)).toBeGreaterThanOrEqual(1.1);
    });

    it("checks the checked track against the generated popover without a widget background", () => {
      const theme = importVsCodeThemeDocument({
        name: "Near-black button",
        type: "dark",
        colors: { "editor.background": "#000000", "button.background": "#151515" },
      });
      const colors = resolve(theme).dark;
      expect(theme.overrides?.dark?.popover).toBeUndefined();
      expect(theme.overrides?.dark?.primary).not.toBe("#151515");
      expect(separation(colors.primary, colors.popover)).toBeGreaterThanOrEqual(1.1);
      expect(separation(colors.ring, colors.popover)).toBeGreaterThanOrEqual(1.1);
    });

    it("keeps the authored button text on its own button background", () => {
      const theme = importVsCodeThemeDocument({
        name: "Button pair",
        type: "dark",
        colors: {
          "editor.background": "#1e1e1e",
          "button.background": "#0e639c",
          "button.foreground": "#ffffff",
        },
      });
      expect(theme.overrides?.dark?.primary).toBe("#0e639c");
      expect(theme.overrides?.dark?.["primary-foreground"]).toBe("#ffffff");
    });

    it("drops button text that is unreadable on a replaced checked track", () => {
      const theme = importVsCodeThemeDocument({
        name: "Transparent button text",
        type: "dark",
        colors: {
          "editor.background": "#1e1e1e",
          "button.background": "#00000000",
          "button.foreground": "#cccccc",
        },
      });
      const colors = resolve(theme).dark;
      expect(theme.overrides?.dark?.["primary-foreground"]).not.toBe("#cccccc");
      expect(separation(colors["primary-foreground"], colors.primary)).toBeGreaterThanOrEqual(4.5);
    });

    it("keeps button text readable on the black or white fallback track", () => {
      const theme = importVsCodeThemeDocument({
        name: "Fallback button text",
        type: "light",
        colors: {
          "editor.background": "#ffffff",
          "editorWidget.background": "#325cbd",
          "button.background": "#ffffff",
          "button.foreground": "#000000",
        },
      });
      const colors = resolve(theme).light;
      expect(separation(colors.primary, colors.background)).toBeGreaterThanOrEqual(1.1);
      expect(separation(colors["primary-foreground"], colors.primary)).toBeGreaterThanOrEqual(4.5);
    });

    it("imports a file whose only supported key is an input border", () => {
      const theme = importVsCodeThemeDocument({
        name: "Border only",
        type: "dark",
        colors: { "input.border": "#585b70" },
      });
      expect(theme.overrides?.dark?.input).toBe("#585b70");
    });

    it("keeps a visible ring when the file has no usable accent key", () => {
      const theme = importVsCodeThemeDocument({
        name: "No accent",
        type: "dark",
        colors: { "editor.background": "#121212", focusBorder: "#121212" },
      });
      const colors = resolve(theme).dark;
      expect(theme.overrides?.dark?.ring).toBeUndefined();
      expect(separation(colors.ring, colors.background)).toBeGreaterThanOrEqual(1.1);
    });
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
