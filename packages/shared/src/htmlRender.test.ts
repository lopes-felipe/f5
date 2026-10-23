import { describe, expect, it } from "vitest";
import { htmlRenderCsp, htmlRenderDocument } from "./htmlRender";

const theme = { appearance: "dark", variables: {} } as const;

describe("htmlRenderCsp", () => {
  it("blocks remote images and scripts unless remote content is allowed", () => {
    const strict = htmlRenderCsp();
    expect(strict).toContain("img-src data:;");
    expect(strict).toContain("script-src 'unsafe-inline';");
    expect(strict).not.toContain("https:");
    const remote = htmlRenderCsp(true);
    expect(remote).toContain("img-src data: https:;");
    expect(remote).toContain("script-src 'unsafe-inline' https:;");
  });

  it("puts the policy in the document before the page markup", () => {
    const html = htmlRenderDocument('<img src="https://example.test/x">', theme);
    expect(html.indexOf(htmlRenderCsp())).toBeGreaterThan(0);
    expect(html.indexOf(htmlRenderCsp())).toBeLessThan(html.indexOf("<img"));
    expect(htmlRenderDocument("", theme, "", { allowRemoteContent: true })).toContain(
      htmlRenderCsp(true),
    );
  });
});
