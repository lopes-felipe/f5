import { expect, it } from "vitest";
import { applyThemeCss } from "./themeCss";

it("removes external loads from declarations in grouping rules and preserves safe styles", () => {
  applyThemeCss(`
    @page { background-image: url("https://example.test/wallpaper.png"); }
    @media all { .example { color: red; background: url("https://example.test/image.png"); } }
    @layer low, high;
    @font-face { font-family: Remote; src: url("https://example.test/font.woff2"); }
    @counter-style remote { system: cyclic; symbols: url("https://example.test/counter.png"); }
    @property --counter-image { syntax: "<image>"; inherits: false; initial-value: url("https://example.test/counter.png"); }
    @layer high { .nested { & span { color: blue; } color: green; background: url("https://example.test/nested.png"); } }
  `);
  try {
    const rules = [...document.adoptedStyleSheets.at(-1)!.cssRules]
      .map((rule) => rule.cssText)
      .join(" ");
    expect(rules).toContain("color: red");
    expect(rules).toContain("@layer low, high;");
    expect(rules).toContain("color: green");
    expect(rules).not.toContain("example.test");
  } finally {
    applyThemeCss(undefined);
  }
});
