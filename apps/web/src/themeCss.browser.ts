import { expect, it } from "vitest";
import { applyThemeCss } from "./themeCss";

it("removes external loads from declarations in grouping rules and preserves safe styles", () => {
  applyThemeCss(`
    @page { background-image: url("https://example.test/wallpaper.png"); }
    @media all { .example { color: red; background: url("https://example.test/image.png"); } }
  `);
  try {
    const rules = [...document.adoptedStyleSheets.at(-1)!.cssRules]
      .map((rule) => rule.cssText)
      .join(" ");
    expect(rules).toContain("color: red");
    expect(rules).not.toContain("example.test");
  } finally {
    applyThemeCss(undefined);
  }
});
