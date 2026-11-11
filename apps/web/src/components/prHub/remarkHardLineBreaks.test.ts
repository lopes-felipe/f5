import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import ReactMarkdown from "react-markdown";
import { remarkHardLineBreaks } from "./remarkHardLineBreaks";

it("breaks prose newlines without altering code blocks", () => {
  const html = renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [remarkHardLineBreaks],
      children: "first\nsecond\n\n    code\n    lines\n",
    }),
  );
  expect(html).toContain("first<br/>");
  expect(html).toContain("code\nlines\n</code>");
  expect(html.match(/<br\/>/g)).toHaveLength(1);
});
