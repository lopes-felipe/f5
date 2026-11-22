import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MathTypeset from "./MathTypeset";

describe("math typesetting", () => {
  it("renders valid TeX as accessible math", () => {
    const html = renderToStaticMarkup(<MathTypeset tex="x^2" display={false} />);
    expect(html).toContain("katex");
    expect(html).toContain("<math");
  });
  it("leaves incomplete TeX readable", () => {
    expect(renderToStaticMarkup(<MathTypeset tex="\\frac{" display />)).toContain("\\frac{");
  });
  it("repairs literal percentages only after a parse failure", () => {
    expect(renderToStaticMarkup(<MathTypeset tex={"\\text{3.18% yield}"} display />)).toContain(
      "katex",
    );
  });
  it("does not allow active links from TeX", () => {
    const html = renderToStaticMarkup(
      <MathTypeset tex="\\href{javascript:alert(1)}{click}" display={false} />,
    );
    expect(html).not.toMatch(/<a(?:\s|>)/);
    expect(html).not.toContain('href="javascript:');
  });
});
