import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import ReactMarkdown from "react-markdown";
import { remarkHardLineBreaks } from "./remarkHardLineBreaks";

it.each(["\n", "\r\n", "\r"])("breaks prose %j without altering code blocks", (ending) => {
  const html = renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [remarkHardLineBreaks],
      children: ["first", "second", "", "    code", "    lines", ""].join(ending),
    }),
  );
  expect(html).toContain("first<br/>");
  expect(html).toContain("code" + ending + "lines\n</code>");
  expect(html.match(/<br\/>/g)).toHaveLength(1);
  expect(html.match(/<p>[\s\S]*?<\/p>/)?.[0]).not.toContain("\r");
});

it("leaves soft breaks unchanged without the host plugin", () => {
  const html = renderToStaticMarkup(createElement(ReactMarkdown, { children: "first\nsecond" }));
  expect(html).not.toContain("<br");
});
