import { describe, expect, it } from "vitest";

import {
  CHAT_FONT_SIZE_MAX,
  DEFAULT_MONO_FONT_STACK,
  DEFAULT_UI_FONT_STACK,
  TERMINAL_FONT_SIZE_MIN,
  UI_FONT_SIZE_DEFAULT,
  applyAppearanceSettings,
  fontFamilyCssList,
  normalizeAppearanceSettings,
  parseFontFamilyPreference,
} from "./appearanceSettings";

describe("font family preferences", () => {
  it("accepts curated names and a bounded fallback list", () => {
    expect(parseFontFamilyPreference(" JetBrains Mono, Consolas ")).toEqual({
      valid: true,
      value: "JetBrains Mono, Consolas",
    });
    expect(fontFamilyCssList("JetBrains Mono, monospace")).toBe('"JetBrains Mono", monospace');
  });

  it.each([
    "Arial; color: red",
    "url(https://example.test/font.woff2)",
    "var(--font-sans)",
    '"unterminated',
    "one, two, three, four, five",
  ])("rejects CSS syntax and malformed input: %s", (value) => {
    expect(parseFontFamilyPreference(value).valid).toBe(false);
  });
});

describe("appearance settings", () => {
  it("normalizes invalid sizes and unsafe persisted font values independently", () => {
    expect(
      normalizeAppearanceSettings({
        uiFontFamily: "Arial; background: red",
        uiFontSize: Number.NaN,
        chatFontSize: 100,
        terminalFontSize: 2,
      }),
    ).toMatchObject({
      uiFontFamily: "",
      uiFontSize: UI_FONT_SIZE_DEFAULT,
      chatFontSize: CHAT_FONT_SIZE_MAX,
      terminalFontSize: TERMINAL_FONT_SIZE_MIN,
    });
  });

  it("applies safe root variables consumed by UI, chat, diffs, and terminals", () => {
    const properties = new Map<string, string>();
    const style = {
      fontSize: "",
      setProperty: (name: string, value: string) => properties.set(name, value),
      getPropertyValue: (name: string) => properties.get(name) ?? "",
    };
    const root = { style } as unknown as HTMLElement;
    applyAppearanceSettings(root, {
      uiFontFamily: "Inter",
      uiFontSize: 18,
      chatFontFamily: "Roboto",
      chatFontSize: 16,
      monoFontFamily: "JetBrains Mono",
      terminalFontSize: 13,
    });

    expect(style.fontSize).toBe("18px");
    expect(style.getPropertyValue("--font-sans")).toBe(`"Inter", ${DEFAULT_UI_FONT_STACK}`);
    expect(style.getPropertyValue("--font-mono")).toBe(
      `"JetBrains Mono", ${DEFAULT_MONO_FONT_STACK}`,
    );
    expect(style.getPropertyValue("--f5-chat-font-family")).toBe('"Roboto", var(--font-sans)');
    expect(style.getPropertyValue("--f5-chat-font-size")).toBe("16px");
    expect(style.getPropertyValue("--diffs-font-family")).toContain("JetBrains Mono");
  });
});
