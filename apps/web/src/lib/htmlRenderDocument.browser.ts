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
    // A fixed footer follows the frame, so it must not hold the frame at its current height.
    const fixed = load(
      '<div style="height:300px"></div><div style="position:fixed;bottom:0;height:20px"></div>',
    );
    await expect.poll(() => fixed.at(-1)?.height).toBe(316);
  });

  it("ignores content clipped by an ancestor and anything inside a fixed element", async () => {
    const clipped = load(
      '<div style="height:100px;overflow:hidden"><div style="height:5000px"></div></div><div style="position:absolute;top:0;height:100px;width:10px"></div>',
    );
    await expect.poll(() => clipped.at(-1)?.height).toBe(116);
    const footer = load(
      '<div style="height:300px"></div><div style="position:fixed;bottom:0;left:0;right:0"><p style="margin:0;height:20px">Footer</p></div>',
    );
    await expect.poll(() => footer.at(-1)?.height).toBe(316);
  });

  it("reports whether the page itself changed since the last measurement", async () => {
    const heights = load(
      "<div id=g style=height:100px></div><script>setTimeout(()=>{document.getElementById('g').style.height='400px'},300)</script>",
      150,
    ) as Array<{ height: number; changed?: boolean }>;
    await expect.poll(() => heights.find((entry) => entry.height === 416)?.changed).toBe(true);
    // A resize alone is not a change to the page.
    frames.at(-1)!.style.height = "300px";
    await expect
      .poll(() => heights.at(-1))
      .toMatchObject({ height: 416, viewportHeight: 300, changed: false });
  });

  it("counts absolutely positioned overflow", async () => {
    const heights = load(
      '<div style="position:absolute;top:0;left:0;height:3000px;width:10px"></div>',
    );
    await expect.poll(() => heights.at(-1)?.height).toBeGreaterThanOrEqual(3000);
    expect(heights.at(-1)!.height).toBeLessThanOrEqual(3016);
  });

  it("settles out-of-flow content once the frame takes its measured height", async () => {
    for (const page of [
      '<div style="position:absolute;top:0;left:0;height:3000px;width:10px"></div>',
      '<p>Short</p><div style="position:absolute;top:500px;height:700px;width:10px"></div>',
    ]) {
      const heights = load(page, 120);
      const frame = frames.at(-1)!;
      // Applies each report like the host does, until a round reports the frame's own height.
      await expect
        .poll(
          () => {
            const last = heights.at(-1);
            if (last && last.height !== last.viewportHeight)
              frame.style.height = `${last.height}px`;
            return last && last.height === last.viewportHeight ? last.height : null;
          },
          { timeout: 3000 },
        )
        .not.toBeNull();
      const settled = heights.length;
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(heights.length).toBe(settled);
      expect(heights.at(-1)!.height).toBeGreaterThanOrEqual(page.includes("500px") ? 1200 : 3000);
    }
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
