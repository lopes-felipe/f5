import { wrapCoreCSS, wrapUnsafeCSS } from "@pierre/diffs";
import { afterEach, describe, expect, it } from "vitest";

import { DIFF_PANEL_UNSAFE_CSS } from "./diffPatch";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** Mirrors the shadow DOM @pierre/diffs renders for a split diff, with its real stylesheet. */
function renderWrappedSplitDiff(unsafeCSS: string) {
  const host = document.createElement("div");
  host.style.width = "600px";
  document.body.append(host);
  cleanups.push(() => host.remove());
  const shadow = host.attachShadow({ mode: "open" });
  const side = (name: "deletions" | "additions", content: string) =>
    `<code data-code data-${name}><div data-gutter><div>1</div></div><div data-content>${content}</div></code>`;
  shadow.innerHTML = `
    <style>${wrapCoreCSS("")}</style>
    <style>${wrapUnsafeCSS(unsafeCSS)}</style>
    <pre data-diff data-diff-type="split" data-overflow="wrap">${side(
      "deletions",
      "<div data-line>short</div>",
    )}${side("additions", '<div data-line><span style="display:inline-block;width:420px">wide</span></div>')}</pre>`;
  const contentWidth = (name: "deletions" | "additions") =>
    shadow.querySelector(`[data-${name}] [data-content]`)!.getBoundingClientRect().width;
  return { deletions: contentWidth("deletions"), additions: contentWidth("additions") };
}

describe("DIFF_PANEL_UNSAFE_CSS", () => {
  it("keeps wrapped split code columns equal when one side has wider mounted lines", () => {
    // Without the override the library's 1fr tracks grow with mounted content.
    const library = renderWrappedSplitDiff("");
    expect(library.additions).toBeGreaterThan(library.deletions + 1);

    const panel = renderWrappedSplitDiff(DIFF_PANEL_UNSAFE_CSS);
    expect(panel.deletions).toBeGreaterThan(0);
    expect(Math.abs(panel.additions - panel.deletions)).toBeLessThanOrEqual(1);
  });
});
