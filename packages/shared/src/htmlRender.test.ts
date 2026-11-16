import { describe, expect, it } from "vitest";
import {
  HTML_RENDER_MAX_FIT_HEIGHT,
  HTML_RENDER_MEASURE_SOURCE,
  htmlRenderCsp,
  htmlRenderDocument,
  initialHtmlRenderFit,
  nextHtmlRenderFit,
  readHtmlRenderMeasurement,
  type HtmlRenderFitState,
} from "./htmlRender";

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

describe("htmlRenderDocument", () => {
  it("adds the gutter, theme fonts and the shared measurement", () => {
    const html = htmlRenderDocument("<p>Hi</p>", {
      appearance: "light",
      variables: { "--font-sans": '"Inter", sans-serif', "--bad key": "x", "--x": "a;}</style>" },
    });
    expect(html).toContain("html{box-sizing:border-box;padding:8px;");
    expect(html).toContain("font-family:var(--font-sans");
    expect(html).toContain("code,kbd,pre,samp{font-family:var(--font-mono");
    expect(html).toContain("outline-offset:-2px!important");
    expect(html).toContain('--font-sans:"Inter", sans-serif');
    expect(html).not.toContain("--bad key");
    expect(html).toContain("--x:a/style");
    expect(html).toContain(HTML_RENDER_MEASURE_SOURCE);
    expect(html).toContain("viewportHeight:innerHeight");
    expect(html).toContain("mode:e.deltaMode");
    expect(html).toContain("color-scheme:light");
  });
});

describe("readHtmlRenderMeasurement", () => {
  it("accepts only finite, bounded geometry", () => {
    expect(
      readHtmlRenderMeasurement({ height: 300, viewportWidth: 800, viewportHeight: 120 }),
    ).toEqual({ height: 300, viewportWidth: 800, viewportHeight: 120, changed: false });
    expect(
      readHtmlRenderMeasurement({
        height: 300,
        viewportWidth: 800,
        viewportHeight: 120,
        changed: true,
      })?.changed,
    ).toBe(true);
    for (const value of [
      300,
      null,
      { height: Number.NaN, viewportWidth: 800, viewportHeight: 120 },
      { height: 300, viewportWidth: Infinity, viewportHeight: 120 },
      { height: 300, viewportWidth: 800 },
      { height: 200_000, viewportWidth: 800, viewportHeight: 120 },
      { height: -1, viewportWidth: 800, viewportHeight: 120 },
    ])
      expect(readHtmlRenderMeasurement(value)).toBeNull();
  });
});

describe("nextHtmlRenderFit", () => {
  const measure = (state: HtmlRenderFitState, height: number, width = 800, changed = false) =>
    nextHtmlRenderFit(state, {
      height,
      viewportWidth: width,
      viewportHeight: state.height,
      changed,
    });
  /** Drives a page whose height is `page(viewport)` until it settles or pauses. */
  const settle = (start: number, page: (viewport: number) => number, rounds = 40) => {
    let state = initialHtmlRenderFit(start);
    for (let index = 0; index < rounds && state.mode !== "paused"; index++) {
      const next = measure(state, page(state.height));
      if (next.height === state.height && next.mode === state.mode) return next;
      state = next;
    }
    return state;
  };

  it("fits tall pages and caps them at the inline limit", () => {
    expect(settle(300, () => 3500)).toMatchObject({ height: 3500, mode: "fit" });
    expect(settle(300, () => 25_000)).toMatchObject({
      height: HTML_RENDER_MAX_FIT_HEIGHT,
      mode: "capped",
    });
    expect(settle(300, () => 40)).toMatchObject({ height: 120, mode: "fit" });
  });

  it("pauses min-height:100vh plus padding where the run started", () => {
    expect(settle(300, (viewport) => viewport + 16)).toMatchObject({ height: 300, mode: "paused" });
  });

  it("pauses percentage heights and frame-height pages that do not touch the DOM", () => {
    expect(settle(300, (viewport) => Math.ceil(viewport * 1.2))).toMatchObject({
      height: 300,
      mode: "paused",
    });
    expect(settle(500, (viewport) => viewport + 50)).toMatchObject({ height: 500, mode: "paused" });
  });

  it("keeps growing pages whose overflow changes each round", () => {
    const heights = [400, 900, 1300, 2600, 2600];
    let index = 0;
    expect(settle(120, () => heights[Math.min(index++, heights.length - 1)]!)).toMatchObject({
      height: 2600,
      mode: "fit",
    });
  });

  it("keeps fitting a page that grows steadily while it changes", () => {
    // Rows appended on a timer, an entrance animation or images decoding one by one:
    // every round sees the same new growth, but the page itself changed in between.
    for (const step of [15, 40, 100]) {
      let state = initialHtmlRenderFit(300);
      for (let round = 0; round < 40; round++)
        state = measure(state, state.height + step, 800, true);
      expect(state).toMatchObject({ mode: "fit", height: 300 + 40 * step });
    }
  });

  it("does not count a few pixels on a tall frame as proportional growth", () => {
    let state = initialHtmlRenderFit(2000);
    const excesses = [10, 25, 40, 55, 70, 85];
    for (const excess of excesses) state = measure(state, state.height + excess);
    expect(state.mode).toBe("fit");
  });

  it("stays paused until the page or width changes, and ignores stale measurements", () => {
    const paused = settle(300, (viewport) => viewport + 16);
    // The loop predicts the height at the frozen frame.
    expect(paused).toMatchObject({ mode: "paused", height: 300, pausedContent: 316 });
    const baseline = measure(paused, 316);
    expect(baseline).toBe(paused);
    // A page that keeps changing (a ticking clock) while the loop holds stays paused.
    expect(measure(baseline, 316, 800, true)).toBe(baseline);
    // Content that changes without the page changing (the frame or CSS alone) stays paused.
    expect(measure(baseline, 900)).toMatchObject({ mode: "paused", height: 300 });
    // A page that changes and grows with it resumes fitting.
    expect(measure(baseline, 900, 800, true)).toMatchObject({ mode: "fit", height: 900 });
    // A change reported before the frozen height landed counts at the next measurement there.
    const early = nextHtmlRenderFit(baseline, {
      height: 5000,
      viewportWidth: 800,
      viewportHeight: 348,
      changed: true,
    });
    expect(early).toMatchObject({ mode: "paused", height: 300, pausedChange: true });
    expect(measure(early, 900)).toMatchObject({ mode: "fit", height: 900 });
    // A new width resumes only a page whose height at the frozen frame moved with it.
    expect(measure(paused, 640, 600)).toMatchObject({ height: 640, mode: "fit" });
    expect(measure(paused, 316, 600)).toMatchObject({ height: 300, mode: "paused", width: 600 });
    const growing = measure(initialHtmlRenderFit(300), 320);
    const stale = nextHtmlRenderFit(growing, {
      height: 336,
      viewportWidth: 800,
      viewportHeight: 300,
    });
    expect(stale.run).toEqual(growing.run);
    expect(stale.height).toBe(336);
  });

  it("starts a remounted paused page paused, learning its width if unknown", () => {
    const remounted = initialHtmlRenderFit(300, HTML_RENDER_MAX_FIT_HEIGHT, { width: 800 });
    expect(remounted).toMatchObject({ mode: "paused", height: 300, width: 800 });
    // The first measurement after loading is the baseline, though loading counts as a change.
    const loaded = measure(remounted, 316, 800, true);
    expect(loaded).toMatchObject({ mode: "paused", height: 300, pausedContent: 316 });
    expect(measure(loaded, 900, 800, true)).toMatchObject({ mode: "fit", height: 900 });
    expect(measure(remounted, 900, 640)).toMatchObject({ mode: "fit", height: 900 });
    const unknown = { ...remounted, width: null };
    expect(measure(unknown, 316, 640)).toMatchObject({ mode: "paused", width: 640 });
  });
});
