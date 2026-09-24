import { chromium } from "playwright";
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
  await measure("browser.composer-input-streaming", typeMeasurement, clearEditor);
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
  report.loaded = await control("stats");
  if (errors.length) throw new Error(`Browser runtime errors: ${errors.join("\n")}`);
  writeFileSync(output, JSON.stringify(report), { flag: "wx" });
} catch (error) {
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
