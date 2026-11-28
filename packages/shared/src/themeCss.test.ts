import { expect, it } from "vitest";
import { themeCssLoadsRemoteFiles } from "./themeCss";

it.each(['url("data:image/png;base64,AA" )', "url('#gradient' \t)"])(
  "allows safe quoted URLs with trailing whitespace in %s",
  (value) => expect(themeCssLoadsRemoteFiles("a { background: " + value + "; }")).toBe(false),
);

it("allows a quoted data image that refers to its own SVG gradient", () => {
  expect(
    themeCssLoadsRemoteFiles(
      '.sample { background: url("data:image/svg+xml,%3Crect fill=%22url(%23gradient)%22/%3E"); }',
    ),
  ).toBe(false);
});

it("allows escapes and literal at-rule names in quoted content", () => {
  expect(themeCssLoadsRemoteFiles('a::after { content: "Say \\"@import\\"."; }')).toBe(false);
});

it("scans long stylesheets with an unfinished string", () => {
  expect(themeCssLoadsRemoteFiles("a{color:red;}\n".repeat(6500) + 'a{content:"unfinished')).toBe(
    true,
  );
});

it.each([
  'a{content:"/*"} b{background:url(https://example.test/image)} c{content:"*/"}',
  '@import "https://example.test/theme.css";',
  '.sample { background: url("/relative.png"); }',
  '.sample { background: url(" data:image/png;base64,AA"); }',
  '.sample { background: image-set("https://example.test/file.png"); }',
  '.sample { content: "url(data:" url("https://example.test/file.png") ")"; }',
])("refuses file loads in %s", (css) => {
  expect(themeCssLoadsRemoteFiles(css)).toBe(true);
});
