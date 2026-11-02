import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { BUILTIN_THEME_PALETTES, resolveThemePalette } from "../themePalette";
import {
  HtmlRenderThemeProvider,
  useHtmlRenderTheme,
  useHtmlRenderThemes,
  type HtmlRenderThemes,
} from "./useHtmlRenderTheme";

const seen: Array<{ theme: ReturnType<typeof useHtmlRenderTheme>; both: HtmlRenderThemes }> = [];
function Probe() {
  seen.push({ theme: useHtmlRenderTheme(), both: useHtmlRenderThemes() });
  return null;
}
const settings = { uiFontFamily: "", monoFontFamily: "" };

describe("HtmlRenderThemeProvider", () => {
  it("shares one snapshot, follows appearance and restyles on palette or font changes", async () => {
    seen.length = 0;
    const palette = BUILTIN_THEME_PALETTES[0]!;
    const other = BUILTIN_THEME_PALETTES.at(-1)!;
    const tree = (props: {
      palette: typeof palette;
      appearance: "light" | "dark";
      settings: typeof settings;
    }) => (
      <HtmlRenderThemeProvider {...props}>
        <Probe />
        <Probe />
      </HtmlRenderThemeProvider>
    );
    const view = await render(tree({ palette, appearance: "dark", settings }));
    expect(seen).toHaveLength(2);
    expect(seen[0]!.theme).toBe(seen[1]!.theme);
    expect(seen[0]!.theme.appearance).toBe("dark");
    expect(seen[0]!.both.light.appearance).toBe("light");

    // A rebuilt palette with the same colors keeps the snapshot.
    const first = seen[0]!.theme;
    await view.rerender(
      tree({ palette: resolveThemePalette(palette.id, []), appearance: "dark", settings }),
    );
    expect(seen.at(-1)!.theme).toBe(first);

    await view.rerender(tree({ palette, appearance: "light", settings }));
    const light = seen.at(-1)!;
    expect(light.theme.appearance).toBe("light");
    expect(light.theme).toBe(light.both.light);
    expect(light.both.dark).toBe(first);

    await view.rerender(tree({ palette: other, appearance: "light", settings }));
    expect(seen.at(-1)!.theme.variables["--primary"]).not.toBe(light.theme.variables["--primary"]);

    await view.rerender(
      tree({
        palette: other,
        appearance: "light",
        settings: { ...settings, uiFontFamily: "Arial" },
      }),
    );
    expect(seen.at(-1)!.theme.variables["--font-sans"]).toMatch(/^"?Arial"?, /);
  });

  it("falls back to the default palette outside the app root", async () => {
    seen.length = 0;
    await render(<Probe />);
    expect(seen[0]!.theme.variables["--background"]).toMatch(/^#[0-9a-f]{6}$/);
    expect(seen[0]!.theme.variables["--font-mono"]).toContain("JetBrains Mono");
  });
});
