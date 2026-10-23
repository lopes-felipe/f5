import { describe, expect, it } from "vitest";
import { cssColorToHex } from "./useHtmlRenderTheme";

describe("cssColorToHex", () => {
  it("turns the color syntaxes the app's theme uses into hex", () => {
    expect(cssColorToHex("#ABCDEF")).toBe("#abcdef");
    expect(cssColorToHex("rgb(255 0 0)")).toBe("#ff0000");
    expect(cssColorToHex("oklch(1 0 0)")).toBe("#ffffff");
    expect(cssColorToHex("oklch(0.488 0.217 264)")).toMatch(/^#[0-9a-f]{6}$/);
    expect(cssColorToHex("color-mix(in srgb, #000 50%, #fff)")).toMatch(/^#[78][0-9a-f]{5}$/);
    expect(cssColorToHex("Canvas")).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("keeps translucent and invalid values as they are", () => {
    expect(cssColorToHex("rgb(0 0 0 / 50%)")).toBeNull();
    expect(cssColorToHex("transparent")).toBeNull();
    expect(cssColorToHex("not a color")).toBeNull();
    expect(cssColorToHex("")).toBeNull();
  });
});
