// Captures the docs screenshots listed in `scripts/docs-screenshots.manifest.ts`
// from a running F5 web server seeded with demo data. Driven by
// `scripts/capture-screenshots.ts` at the repo root, which owns the sandbox,
// the server and the safety checks. Images are written under
// <out-dir>/docs/images as WebP; the caller copies them into the repo only
// after every shot and check succeeds.
//
// Usage: node scripts/capture-docs-screenshots.mjs <server-url> <out-dir> [--only id,id]
import { chromium } from "playwright";
import * as FS from "node:fs";
import * as Path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { DOCS_SHOTS } from "../../../scripts/docs-screenshots.manifest.ts";

const [baseUrl, outDir, ...rest] = process.argv.slice(2);
if (!baseUrl || !outDir) {
  console.error("Usage: capture-docs-screenshots.mjs <server-url> <out-dir> [--only id,id]");
  process.exit(1);
}
const onlyIndex = rest.indexOf("--only");
const onlyIds = onlyIndex === -1 ? null : new Set((rest[onlyIndex + 1] ?? "").split(","));
const shots = DOCS_SHOTS.filter((shot) => !onlyIds || onlyIds.has(shot.id));

const VIEWPORT = { width: 1440, height: 900 };
const DEVICE_SCALE_FACTOR = 2;
const WAIT_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 10_000;
const MAX_IMAGE_BYTES = 600 * 1024;
const WEBP_QUALITY = 0.9;
const SHOT_ATTEMPTS = 2;
// Provider health probes finish shortly after boot and re-render open
// popovers; let them land before the first capture.
const POST_BOOT_SETTLE_MS = 5_000;
const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";

// Suppress animations, transitions, the text caret and scrollbars so repeated
// runs produce the same pixels.
const STABILIZING_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  caret-color: transparent !important;
}
* { scrollbar-width: none !important; }
*::-webkit-scrollbar { display: none !important; }
`;

const browser = await chromium.launch();
process.once("SIGTERM", () => {
  void browser.close().finally(() => process.exit(143));
});

// Separate contexts keep the capture page and the encoding page from sharing
// focus; an open popover closes when another page in its context is active.
const newPage = async () => {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    colorScheme: "dark",
    reducedMotion: "reduce",
    timezoneId: "UTC",
    locale: "en-US",
  });
  context.setDefaultTimeout(ACTION_TIMEOUT_MS);
  await context.addInitScript(
    ({ key, css }) => {
      if (localStorage.getItem(key) === null) {
        localStorage.setItem(key, JSON.stringify({ onboardingLiteStatus: "dismissed" }));
      }
      const install = () => {
        const style = document.createElement("style");
        style.textContent = css;
        document.head.append(style);
      };
      if (document.head) install();
      else document.addEventListener("DOMContentLoaded", install, { once: true });
    },
    { key: APP_SETTINGS_STORAGE_KEY, css: STABILIZING_CSS },
  );
  return await context.newPage();
};

const resolveLocator = (page, locator) => {
  if ("role" in locator) return page.getByRole(locator.role, { name: locator.name }).first();
  if ("text" in locator) return page.getByText(locator.text, { exact: false }).first();
  return page.locator(locator.css).first();
};

const unionClip = async (page, locators, padding, viewport) => {
  const boxes = await Promise.all(
    locators.map(async (locator) => {
      const box = await resolveLocator(page, locator).boundingBox();
      if (!box) throw new Error(`no bounding box for ${JSON.stringify(locator)}`);
      return box;
    }),
  );
  const left = Math.max(0, Math.min(...boxes.map((box) => box.x)) - padding);
  const top = Math.max(0, Math.min(...boxes.map((box) => box.y)) - padding);
  const right = Math.min(
    viewport.width,
    Math.max(...boxes.map((box) => box.x + box.width)) + padding,
  );
  const bottom = Math.min(
    viewport.height,
    Math.max(...boxes.map((box) => box.y + box.height)) + padding,
  );
  return { x: left, y: top, width: right - left, height: bottom - top };
};

const captureShot = async (page, shot) => {
  const viewport = shot.viewport ?? VIEWPORT;
  await page.setViewportSize(viewport);
  await page.goto(`${baseUrl}${shot.route}`);
  await resolveLocator(page, shot.waitFor).waitFor({ state: "visible", timeout: WAIT_TIMEOUT_MS });
  const dismiss = page.getByRole("button", { name: "Dismiss provider status" });
  for (const button of await dismiss.all()) {
    if (await button.isVisible()) await button.click();
  }
  for (const step of shot.steps ?? []) {
    if ("click" in step) {
      await resolveLocator(page, step.click).click({ modifiers: [...(step.modifiers ?? [])] });
    } else if ("fill" in step) {
      await resolveLocator(page, step.fill).fill(step.value);
    } else if ("waitFor" in step) {
      await resolveLocator(page, step.waitFor).waitFor({
        state: "visible",
        timeout: WAIT_TIMEOUT_MS,
      });
    } else {
      // Chat timelines stick to the bottom until the user scrolls, so wheel
      // up over the element first, then align it with the top of its
      // scroll container.
      const element = resolveLocator(page, step.scrollIntoView);
      const box = await element.boundingBox();
      if (box) {
        await page.mouse.move(
          box.x + box.width / 2,
          Math.max(1, Math.min(box.y, viewport.height - 1)),
        );
        await page.mouse.wheel(0, -400);
        await delay(200);
      }
      await element.evaluate((node) => node.scrollIntoView({ block: "start" }));
    }
  }
  // Keep the pointer out of hover states, then let fonts and layout settle.
  await page.mouse.move(viewport.width - 1, viewport.height - 1);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await delay(400);
  const target = shot.target ?? "page";
  if (target === "page") return await page.screenshot({ type: "png" });
  if ("union" in target) {
    const clip = await unionClip(page, target.union, target.padding ?? 0, viewport);
    return await page.screenshot({ type: "png", clip });
  }
  return await resolveLocator(page, target).screenshot({ type: "png" });
};

// Chromium encodes WebP through canvas, so no image dependency is needed.
const encodeWebp = async (page, png) => {
  await page.setContent("<!doctype html><html><body></body></html>");
  const dataUrl = await page.evaluate(
    async ({ source, quality }) => {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext("2d").drawImage(image, 0, 0);
      return canvas.toDataURL("image/webp", quality);
    },
    { source: `data:image/png;base64,${png.toString("base64")}`, quality: WEBP_QUALITY },
  );
  const prefix = "data:image/webp;base64,";
  if (!dataUrl.startsWith(prefix)) throw new Error("Chromium did not produce a WebP image");
  return Buffer.from(dataUrl.slice(prefix.length), "base64");
};

const failures = [];
try {
  const page = await newPage();
  const encoder = await newPage();
  const imagesDir = Path.join(outDir, "docs/images");
  FS.mkdirSync(imagesDir, { recursive: true });
  await delay(POST_BOOT_SETTLE_MS);

  for (const shot of shots) {
    try {
      let png = null;
      for (let attempt = 1; png === null; attempt++) {
        try {
          // Close any popup left open by the previous shot.
          await page.keyboard.press("Escape").catch(() => undefined);
          png = await captureShot(page, shot);
        } catch (error) {
          if (attempt >= SHOT_ATTEMPTS) throw error;
          console.warn(`[capture-docs] ${shot.id} attempt ${attempt} failed; retrying`);
        }
      }
      const webp = await encodeWebp(encoder, png);
      const sizeKb = Math.round(webp.byteLength / 1024);
      if (webp.byteLength > MAX_IMAGE_BYTES) {
        failures.push(`${shot.id}: ${sizeKb} KB exceeds ${MAX_IMAGE_BYTES / 1024} KB`);
        continue;
      }
      FS.writeFileSync(Path.join(imagesDir, `${shot.id}.webp`), webp);
      console.log(`[capture-docs] captured docs/images/${shot.id}.webp (${sizeKb} KB)`);
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      failures.push(`${shot.id}: ${message}`);
      const debugPath = Path.join(outDir, `failed-${shot.id}.png`);
      await page.screenshot({ path: debugPath }).catch(() => undefined);
      console.error(`[capture-docs] ${shot.id} failed; page captured at ${debugPath}`);
    }
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`[capture-docs] ${failures.length} shot(s) failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
