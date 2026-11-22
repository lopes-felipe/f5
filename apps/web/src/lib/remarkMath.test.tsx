import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { describe, expect, it } from "vitest";
import { remarkMath } from "./remarkMath";

const render = (text: string) =>
  renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkMath]}>{text}</ReactMarkdown>);

describe("math tokenization", () => {
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
    expect(render("$$a +\nb$$")).toContain("math-display");
  });
});
