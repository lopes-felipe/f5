import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { describe, expect, it } from "vitest";
import { remarkMath } from "./remarkMath";
import remarkGfm from "remark-gfm";

const render = (text: string) =>
  renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkMath]}>{text}</ReactMarkdown>);

describe("math tokenization", () => {
  it.each(["\\(\\frac{a}{b}\\)", "\\[\\frac{a}{b}\\]"])("keeps TeX commands in %s", (formula) => {
    expect(render(formula)).toContain("language-math");
    expect(render(formula)).toContain("\\frac{a}{b}");
  });
  it.each([
    "Run $browser then $deploy on it.",
    "Price $5 and $10 stays literal.",
    "Set $TOKEN, then open [users](https://example.com/?$select=id)",
    "$TOKEN then see [docs](/api?$filter=1)",
    "$   $",
    "\\( \\) prose",
    "\\[1,2\\] prose",
  ])("leaves prose alone: %s", (text) => {
    expect(render(text)).not.toContain("language-math");
  });
  it("does not consume a later formula as part of a price", () => {
    const html = render("Price $5 and $10 stays literal. The formula is $x_i$");
    expect(html.match(/language-math/g)).toHaveLength(1);
    expect(html).toContain("Price $5 and $10");
    expect(html).toContain(">x_i</code>");
  });
  it("preserves escaped dollars inside formulas", () => {
    expect(render("$a\\$b$")).toContain(">a\\$b</code>");
  });
  it("keeps adjacent brackets in explicit display math", () => {
    expect(render("$$[a](b)$$")).toContain(">[a](b)</code>");
  });
  it("does not absorb the next equation after an empty TeX span", () => {
    const html = render("\\( \\) prose \\(x\\)");
    expect(html).toContain(">x</code>");
    expect(html).toContain("prose");
  });
  it.each(["$|x|$", "\\(a|b\\)", "$a\\mid b|c$"])("preserves table cells around %s", (formula) => {
    const html = renderToStaticMarkup(
      <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm]}>
        {"| Formula | Value |\n| --- | --- |\n| " + formula + " | 1 |"}
      </ReactMarkdown>,
    );
    expect(html.match(/<td>/g)).toHaveLength(2);
    expect(html).toContain("language-math");
    expect(html).toContain("<td>1</td>");
    expect(html).not.toContain("\uE000");
  });
  it.each(["$a_b * c$", "\\(a_b * c\\)", "$$a_b * c$$", "\\[a_b * c\\]"])(
    "preserves TeX instead of parsing Markdown in %s",
    (source) => {
      expect(render(source)).toContain("a_b * c");
      expect(render(source)).toContain("language-math");
      expect(render(source)).not.toContain("<em>");
    },
  );
  it("leaves code, currency, escaped dollars and unfinished expressions alone", () => {
    expect(render("Cost $5 and $10")).not.toContain("language-math");
    expect(render("`$a$`")).not.toContain("language-math");
    expect(render("\\$a\\$")).not.toContain("language-math");
    expect(render("$a_b")).not.toContain("language-math");
  });
  it("allows display math across lines", () => {
    const html = render("$$a + % comment\nb$$");
    expect(html).toContain("math-display");
    expect(html).toContain("a + % comment\nb</code>");
  });
  it("preserves math content without blockquote or list continuation prefixes", () => {
    expect(render("> $$a + % comment\n> b$$")).toContain("a + % comment\nb</code>");
    expect(render("- $$a +\n  b$$")).toContain("a +\nb</code>");
  });
});
