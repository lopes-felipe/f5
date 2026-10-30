import { htmlRenderDocument } from "@t3tools/shared/htmlRender";
import { afterEach, describe, expect, it } from "vitest";

// The shared bootstrap needs real layout, so its measurement is checked here.
const frames: HTMLIFrameElement[] = [];
afterEach(() => {
  for (const frame of frames.splice(0)) frame.remove();
});

function load(html: string, height = 800) {
  const bridge = crypto.randomUUID();
  const frame = document.createElement("iframe");
  frame.sandbox.add("allow-scripts");
  frame.style.cssText = `width:600px;height:${height}px;border:0`;
  const heights: Array<{ height: number; viewportHeight: number; at: number }> = [];
  const connect = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || event.data?.f5HtmlRender !== bridge) return;
    window.removeEventListener("message", connect);
    const port = event.ports[0]!;
    port.onmessage = (message) => {
      if (message.data?.type === "height")
        heights.push({ ...message.data.value, at: performance.now() });
    };
  };
  window.addEventListener("message", connect);
  frame.srcdoc = htmlRenderDocument(html, { appearance: "dark", variables: {} }, bridge);
  document.body.append(frame);
  frames.push(frame);
  return heights;
}

describe("htmlRenderDocument measurement", () => {
  it("reports a short page's own height with its gutter, not the frame's", async () => {
    const heights = load('<div style="height:300px"></div>');
    await expect.poll(() => heights.at(-1)?.height).toBe(316);
    expect(heights.at(-1)?.viewportHeight).toBe(800);
  });

  it("counts absolutely positioned overflow", async () => {
    const heights = load(
      '<div style="position:absolute;top:0;left:0;height:3000px;width:10px"></div>',
    );
    await expect.poll(() => heights.at(-1)?.height).toBeGreaterThanOrEqual(3000);
    expect(heights.at(-1)!.height).toBeLessThanOrEqual(3016);
  });

  it("keeps measuring a page that changes continuously", async () => {
    const heights = load(
      "<div id=grow></div><script>let n=0;const timer=setInterval(()=>{document.getElementById('grow').style.height=(++n*4)+'px';if(n>=150)clearInterval(timer)},5)</script>",
      100,
    );
    // A restarting debounce would report only once the page stops changing.
    await expect.poll(() => heights.length, { timeout: 3000 }).toBeGreaterThanOrEqual(5);
    const first = heights[0]!.at;
    expect(heights.filter((entry) => entry.at - first < 600).length).toBeGreaterThanOrEqual(3);
    const gaps = heights.slice(1).map((entry, index) => entry.at - heights[index]!.at);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(40);
  });
});
