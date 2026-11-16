// Captures the README screenshots and the marketing hero image from a running
// F5 web server seeded with demo data. Driven by `scripts/capture-screenshots.ts`
// at the repo root, which owns the sandbox, the server and the safety checks.
// Images are written under <out-dir> with their repo-relative paths; the
// caller copies them into the repo only after every shot and check succeeds.
//
// Usage: node scripts/capture-readme-screenshots.mjs <server-url> <out-dir>
import { chromium } from "playwright";
import * as FS from "node:fs";
import * as Path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [baseUrl, outDir] = process.argv.slice(2);
if (!baseUrl || !outDir) {
  console.error("Usage: capture-readme-screenshots.mjs <server-url> <out-dir>");
  process.exit(1);
}

const DEVICE_SCALE_FACTOR = 2;
const WAIT_TIMEOUT_MS = 20_000;
const SETTLE_MS = 600;
const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";
const BLOCKING_SURFACES = [
  '[data-slot="skeleton"]',
  '[data-slot="surface-error"]',
  '[data-slot="toast-title"]',
];

const browser = await chromium.launch();
process.once("SIGTERM", () => {
  void browser.close().finally(() => process.exit(143));
});

const pageErrors = [];
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  await context.addInitScript((key) => {
    if (localStorage.getItem(key) === null) {
      localStorage.setItem(key, JSON.stringify({ onboardingLiteStatus: "dismissed" }));
    }
  }, APP_SETTINGS_STORAGE_KEY);
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  const out = (relative) => {
    const file = Path.join(outDir, relative);
    FS.mkdirSync(Path.dirname(file), { recursive: true });
    return file;
  };

  const waitFor = async (shot, locator, description) => {
    try {
      await locator.waitFor({ state: "visible", timeout: WAIT_TIMEOUT_MS });
    } catch {
      throw new Error(`[${shot}] timed out waiting for ${description}`);
    }
  };

  const waitForAttached = async (shot, locator, description) => {
    try {
      await locator.waitFor({ state: "attached", timeout: WAIT_TIMEOUT_MS });
    } catch {
      throw new Error(`[${shot}] timed out waiting for ${description}`);
    }
  };

  const prepare = async (shot, { keepDialog = false } = {}) => {
    await page.evaluate(() => document.fonts.ready);
    const dismiss = page.getByRole("button", { name: "Dismiss provider status" });
    for (const button of await dismiss.all()) {
      if (await button.isVisible()) await button.click();
    }
    if (!keepDialog) await page.keyboard.press("Escape");
    await page.mouse.move(0, 0);
    await delay(SETTLE_MS);
    for (const selector of BLOCKING_SURFACES) {
      for (const element of await page.locator(selector).all()) {
        if (await element.isVisible()) {
          const text = (await element.textContent())?.trim() ?? "";
          throw new Error(`[${shot}] blocking surface ${selector} is visible: ${text}`);
        }
      }
    }
    if (pageErrors.length > 0) throw new Error(`[${shot}] page error: ${pageErrors[0]}`);
  };

  const capture = async (shot, relative, options = {}) => {
    await page.screenshot({ path: out(relative), ...options });
    console.log(`[capture] captured ${relative}`);
    if (pageErrors.length > 0) throw new Error(`[${shot}] page error: ${pageErrors[0]}`);
  };

  // Home + marketing hero.
  await page.goto(`${baseUrl}/`);
  await waitFor("home", page.getByRole("listbox", { name: "Queue" }), "the Home queue");
  // The preview pane loads after the queue.
  await waitFor("home", page.locator('[data-slot="home-preview"]'), "the Home preview");
  await prepare("home");
  if ((await page.getByText("Planning workflows").count()) > 0) {
    throw new Error("[home] onboarding panel is visible");
  }
  await capture("home", "assets/screenshots/home.png");
  await capture("home", "apps/marketing/public/screenshot.jpeg", { type: "jpeg", quality: 85 });

  // New workflow dialog, filled in but never submitted.
  await page.getByRole("button", { name: "New workflow" }).first().click();
  const dialog = page.getByRole("dialog").first();
  await waitFor("new-workflow", dialog, "the New workflow dialog");
  for (const type of ["Feature", "Code Review", "Investigation", "Document"]) {
    await waitFor("new-workflow", dialog.getByText(type, { exact: true }).first(), `"${type}"`);
  }
  await dialog
    .locator('textarea, [contenteditable="true"]')
    .first()
    .fill(
      "Add offline sync to the todo list: queue edits locally and replay them when the server is reachable.",
    );
  await prepare("new-workflow", { keepDialog: true });
  await capture("new-workflow", "assets/screenshots/new-workflow.png");
  await page.keyboard.press("Escape");

  // Finished Feature workflow with the merged plan.
  await page.goto(`${baseUrl}/workflow/workflow-rss-parallel-refresh`);
  await waitFor(
    "workflow",
    page.getByText("Parallelize feed refresh").first(),
    "the workflow title",
  );
  await waitFor(
    "workflow",
    page.getByText("Parallel feed refresh with per-host limits").first(),
    "the merged plan heading",
  );
  await prepare("workflow");
  await capture("workflow", "assets/screenshots/workflow.png");

  // Code Review workflow with consolidated findings.
  await page.goto(`${baseUrl}/code-review/review-todo-kanban-pr`);
  await waitFor(
    "code-review",
    page.getByText("Consolidated verdict").first(),
    '"Consolidated verdict"',
  );
  await prepare("code-review");
  await capture("code-review", "assets/screenshots/code-review.png");

  // Chat thread with the recorded file change open in the diff panel.
  await page.goto(
    `${baseUrl}/thread-snippet-postgres?diff=1&diffFileChangeId=fc-snippet-pg-adapter`,
  );
  await waitFor(
    "thread",
    page.getByText("Add Postgres backend support").first(),
    "the thread title",
  );
  await waitForAttached(
    "thread",
    page.locator('[data-diff-file-path="src/adapters/postgres/index.ts"]').first(),
    "the Postgres adapter diff",
  );
  await prepare("thread");
  await capture("thread", "assets/screenshots/thread.png");
} finally {
  await browser.close();
}
