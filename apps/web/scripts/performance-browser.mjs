import { chromium } from "playwright";
import { installBrowserPerformanceCounters } from "../src/lib/browserPerformanceCollector.ts";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const [url, output, mode, minutesText] = process.argv.slice(2);
const smoke = mode === "smoke";
const minutes = Number(minutesText);
const method = smoke ? { warmups: 1, repetitions: 2 } : { warmups: 5, repetitions: 30 };
const browser = await chromium.launch({
  args: [
    "--js-flags=--expose-gc",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
  ],
});
const config = {
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "no-preference",
  headless: true,
};
const context = await browser.newContext({
  viewport: config.viewport,
  reducedMotion: config.reducedMotion,
});
await context.addInitScript(installBrowserPerformanceCounters);
await context.addInitScript(() => {
  window.__perfStartup = new Promise((resolve) => {
    const ready = () => {
      const row = document.querySelector('[data-message-id="perf-small-message-19"]');
      if (row?.getBoundingClientRect().height && document.querySelector('[contenteditable="true"]'))
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())));
      else requestAnimationFrame(ready);
    };
    requestAnimationFrame(ready);
  });
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const browserCdp = await browser.newBrowserCDPSession();
const errors = [];
page.on("pageerror", (error) => {
  if (errors.length < 20) errors.push(String(error));
});
const report = {
  browser: browser.version(),
  config,
  method,
  measurements: {},
  memory: [],
  errors,
  loaded: {},
  diagnostics: {},
};
const editor = page.locator('[contenteditable="true"]').first();
const title = (id) =>
  id === "perf-large"
    ? "Performance large thread"
    : id === "perf-small"
      ? "Performance small thread"
      : id;
const threadLink = (id) =>
  page
    .locator("[data-thread-item]")
    .filter({ hasText: title(id) })
    .locator('[role="button"]')
    .first();
const row = (id) => page.locator(`[data-message-id="${id}"]`);
const painted = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const control = async (command) => {
  const response = await fetch(`${url}/_perf/${command}`, { method: "POST" });
  if (!response.ok) throw new Error(`Control failed: ${command}`);
  return response.json();
};
const rendererCpu = async () => {
  const { processInfo } = await browserCdp.send("SystemInfo.getProcessInfo");
  return processInfo
    .filter((p) => p.type === "renderer")
    .reduce((sum, p) => sum + p.cpuTime * 1000, 0);
};
async function measure(name, operation, prepare = async () => {}) {
  console.log(`measuring ${name}`);
  const samples = { wallMs: [], cpuMs: [] };
  for (let i = -method.warmups; i < method.repetitions; i++) {
    await prepare();
    const cpu = await rendererCpu();
    let timer;
    let wall;
    try {
      wall = await Promise.race([
        operation(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Measurement timed out: ${name}`)), 30000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const used = (await rendererCpu()) - cpu;
    if (!Number.isFinite(wall) || wall < 0 || used < 0)
      throw new Error(`Invalid measurement ${name}`);
    if (i >= 0) {
      samples.wallMs.push(wall);
      samples.cpuMs.push(used);
    }
  }
  report.measurements[name] = samples;
}
async function navigate(id) {
  if ((await threadLink(id).count()) === 0)
    await page.getByRole("button", { name: "Show more", exact: true }).click();
  await threadLink(id).click();
  await editor.waitFor();
  await painted();
}
async function settleTimeline() {
  await page.evaluate(async () => {
    let previous = "",
      stable = 0;
    const deadline = performance.now() + 10_000;
    while (stable < 6) {
      await new Promise(requestAnimationFrame);
      const node = document.querySelector('[data-slot="messages-scroll-container"]');
      const current = node ? `${node.scrollTop}:${node.scrollHeight}` : "";
      stable = current && current === previous ? stable + 1 : 0;
      previous = current;
      if (performance.now() > deadline)
        throw new Error("Timeline did not finish its initial scroll");
    }
  });
}
async function typeMeasurement() {
  await page.evaluate(() => {
    const editable = document.querySelector('[contenteditable="true"]');
    window.__perfInput = new Promise((resolve) => {
      document.addEventListener(
        "beforeinput",
        () => {
          const start = performance.now();
          const check = () => {
            if (!editable.textContent.includes("performance sample")) return;
            observer.disconnect();
            requestAnimationFrame(() =>
              requestAnimationFrame(() => resolve(performance.now() - start)),
            );
          };
          const observer = new MutationObserver(check);
          observer.observe(editable, { subtree: true, childList: true, characterData: true });
          check();
        },
        { once: true, capture: true },
      );
    });
  });
  await page.keyboard.insertText("performance sample");
  await editor.filter({ hasText: "performance sample" }).waitFor();
  return page.evaluate(() => window.__perfInput);
}
async function clearEditor() {
  await editor.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.press("Backspace");
  await painted();
}
try {
  await page.goto(`${url}/perf-small`, { waitUntil: "networkidle" });
  await editor.waitFor({ timeout: 30000 });
  await row("perf-small-message-19").waitFor();
  await measure("browser.startup-small", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await row("perf-small-message-19").waitFor();
    await editor.waitFor();
    await painted();
    return page.evaluate(() => window.__perfStartup);
  });
  await navigate("perf-large");
  await row("perf-message-9999").waitFor();
  await navigate("perf-small");
  if ((await threadLink("perf-large").count()) === 0)
    await page.getByRole("button", { name: "Show more", exact: true }).click();
  await measure(
    "browser.warm-switch-large",
    async () => {
      await page.evaluate(() => {
        window.__perfNavigation = new Promise((resolve) => {
          Array.from(document.querySelectorAll("[data-thread-item]"))
            .find((row) => row.textContent.includes("Performance large thread"))
            .addEventListener(
              "pointerdown",
              () => {
                const start = performance.now();
                const ready = () => {
                  if (
                    document
                      .querySelector('[data-message-id="perf-message-9999"]')
                      ?.getBoundingClientRect().height
                  )
                    requestAnimationFrame(() =>
                      requestAnimationFrame(() => resolve(performance.now() - start)),
                    );
                  else requestAnimationFrame(ready);
                };
                requestAnimationFrame(ready);
              },
              { once: true },
            );
        });
      });
      await navigate("perf-large");
      await row("perf-message-9999").waitFor();
      await painted();
      return page.evaluate(() => window.__perfNavigation);
    },
    () => navigate("perf-small"),
  );
  await measure("browser.composer-input", typeMeasurement, clearEditor);
  // All ten threads are explicitly visited, rather than measuring only a hidden
  // server emitter while the client discards unloaded thread details.
  for (let i = 0; i < 10; i++) await navigate(`perf-stream-${i}`);
  await navigate("perf-stream-0");
  await control("start-streaming");
  await page
    .getByText(/Streaming frame/)
    .first()
    .waitFor();
  const beforeStreaming = await page.evaluate(() => window.__f5PerformanceCounters.sample());
  await measure("browser.composer-input-streaming", typeMeasurement, clearEditor);
  const afterStreaming = await page.evaluate(() => window.__f5PerformanceCounters.sample());
  report.diagnostics.streaming = { before: beforeStreaming, after: afterStreaming };
  await clearEditor();
  await control("stop-streaming");
  if (minutes > 0) {
    await control("start-soak");
    const start = performance.now();
    for (let sample = 0; sample <= minutes; sample++) {
      const remaining = start + sample * 60000 - performance.now();
      if (remaining > 0) await delay(remaining);
      await cdp.send("HeapProfiler.collectGarbage");
      const usage = await cdp.send("Runtime.getHeapUsage");
      const server = await control("sample-soak");
      report.memory.push({
        elapsedMs: performance.now() - start,
        heapBytes: usage.usedSize,
        rendererCpuMs: await rendererCpu(),
        server,
      });
      // Persist progress so an interrupted soak cannot masquerade as a full run.
      writeFileSync(`${output}.progress`, JSON.stringify(report));
      console.log(
        `memory sample ${sample}/${minutes}: browser=${usage.usedSize}, server=${server.heapBytes}`,
      );
    }
    await control("stop-soak");
  }
  if (process.env.F5_PERF_LIFECYCLE === "1") {
    const assert = (condition, message) => {
      if (!condition) throw new Error(message);
    };
    await control("lifecycle-history");
    for (let attempt = 0; attempt < 100 && !(await threadLink("perf-history").count()); attempt++) {
      const more = page.getByRole("button", { name: "Show more", exact: true });
      if (await more.count()) await more.click();
      await delay(50);
    }
    await navigate("perf-history");
    await row("perf-history-message-999").waitFor();
    await settleTimeline();
    await control("start-streaming");
    await navigate("perf-stream-0");
    await page
      .getByText(/Streaming frame/)
      .first()
      .waitFor();
    await navigate("perf-history");
    await settleTimeline();
    const beforeHistory = await page.evaluate(
      () => window.__f5PerformanceCounters.sample().resources.store.retainedMessages,
    );
    const beforeHistoryStats = await control("stats");
    await page.locator('[data-slot="messages-scroll-container"]').hover();
    await page.mouse.wheel(0, -100_000);
    await page.waitForFunction(
      (before) => window.__f5PerformanceCounters.sample().resources.store.retainedMessages > before,
      beforeHistory,
    );
    await page.waitForFunction(() => {
      const anchor = window.__f5PerformanceCounters.lastHistoryAnchor;
      const node = document.querySelector('[data-slot="messages-scroll-container"]');
      if (!anchor?.rowId || !node) return false;
      const row = Array.from(node.querySelectorAll("[data-timeline-row-id]")).find(
        (row) => row.dataset.timelineRowId === anchor.rowId,
      );
      return (
        row &&
        Math.abs(row.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.top) <
          3
      );
    });
    const afterHistoryStats = await control("stats");
    assert(
      (afterHistoryStats.rpc["orchestration.getThreadHistoryPage"] ?? 0) >
        (beforeHistoryStats.rpc["orchestration.getThreadHistoryPage"] ?? 0),
      "History was not loaded while streaming",
    );
    assert(
      afterHistoryStats.frames > beforeHistoryStats.frames,
      "Streaming stalled during history loading",
    );
    await control("stop-streaming");
    await navigate("perf-small");
    await editor.fill("unfinished draft during provider failure");
    const preservedDraft = await editor.innerText();
    await control("lifecycle-start");
    const stop = page.getByRole("button", { name: "Stop generation", exact: true });
    await stop.waitFor();
    const full = await control("lifecycle-saturate");
    assert(full.entries === 1024, "Ordinary admission was not saturated");
    await stop.click();
    await stop.waitFor({ state: "hidden" });
    let stats = (await control("stats")).lifecycle;
    assert(
      stats.entries === 1024 && stats.applied["thread.turn.interrupt"] === 1,
      "Stop did not pass saturated ordinary admission exactly once",
    );
    assert((await editor.innerText()) === preservedDraft, "Stop discarded the draft");
    await control("lifecycle-start");
    await stop.waitFor();
    await control("lifecycle-approval");
    const approve = page.getByRole("button", { name: "Approve once", exact: true });
    await approve.waitFor();
    await approve.click();
    await approve.waitFor({ state: "hidden" });
    stats = (await control("stats")).lifecycle;
    assert(
      stats.entries === 1024 && stats.applied["thread.approval.respond"] === 1,
      "Approval did not pass saturated ordinary admission exactly once",
    );
    await control("lifecycle-crash");
    await page
      .getByText("Provider crashed during the turn. Retry when ready.", { exact: true })
      .waitFor();
    await stop.waitFor({ state: "hidden" });
    assert((await editor.innerText()) === preservedDraft, "Provider failure discarded the draft");
    await editor.press("End");
    await editor.pressSequentially(" still editable");
    assert(
      (await editor.innerText()).includes("still editable"),
      "Provider failure blocked editing",
    );
    report.diagnostics.lifecycle = {
      stop: true,
      approval: true,
      providerCrash: true,
      draftPreserved: true,
      historyLoaded: true,
      historyAnchorPreserved: true,
      switchingWhileStreaming: true,
    };
    await control("lifecycle-reset");
  }
  report.loaded = await control("stats");
  if (errors.length) throw new Error(`Browser runtime errors: ${errors.join("\n")}`);
  report.diagnostics.final = await page.evaluate(() => window.__f5PerformanceCounters.sample());
  writeFileSync(output, JSON.stringify(report), { flag: "wx" });
} catch (error) {
  console.error("Fixture diagnostics", await control("stats").catch(() => null));
  console.error(
    "History anchor diagnostics",
    await page
      .evaluate(() => {
        const node = document.querySelector('[data-slot="messages-scroll-container"]');
        const top = node?.getBoundingClientRect().top ?? 0;
        return {
          expected: window.__f5PerformanceCounters.lastHistoryAnchor,
          scrollTop: node?.scrollTop,
          rows: Array.from(node?.querySelectorAll("[data-timeline-row-id]") ?? [])
            .map((row) => ({
              id: row.dataset.timelineRowId,
              top: row.getBoundingClientRect().top - top,
            }))
            .slice(0, 8),
        };
      })
      .catch(() => null),
  );
  console.error(
    await page
      .locator("body")
      .innerText()
      .catch(() => "No page"),
  );
  throw error;
} finally {
  await context.close();
  await browser.close();
}
