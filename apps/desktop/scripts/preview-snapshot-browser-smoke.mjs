import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  createPreviewSnapshotFixture,
  previewSnapshotSecrets as secrets,
} from "./preview-snapshot-fixture.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = createRequire(path.join(root, "apps/web/package.json"))("playwright");
const directory = mkdtempSync(path.join(tmpdir(), "f5-snapshot-browser-"));
const modulePath = path.join(directory, "snapshot.cjs");
execFileSync(
  "bun",
  [
    "build",
    path.join(root, "apps/desktop/src/preview/snapshotScript.ts"),
    "--target=node",
    "--format=cjs",
    "--outfile",
    modulePath,
  ],
  { stdio: "pipe" },
);
const { capturePreviewSnapshotPage } = require(modulePath);
const fixture = await createPreviewSnapshotFixture();
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ["--site-per-process"] });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(fixture.url, { waitUntil: "networkidle" });
  const foreignPage = await context.newPage();
  await foreignPage.goto(fixture.foreignUrl, { waitUntil: "networkidle" });
  assert.equal(page.frames().length, 3);
  const cdp = await context.newCDPSession(page);
  const discovery = await browser.newBrowserCDPSession();
  const { targetInfos } = await discovery.send("Target.getTargets");
  assert.ok(
    targetInfos.some((target) => target.type === "iframe"),
    "Fixture must have out-of-process frames",
  );
  const foreignTargets = new Set(
    targetInfos
      .filter((target) => target.type === "iframe" && target.url.includes("foreign=1"))
      .map((target) => target.targetId),
  );
  assert.ok(foreignTargets.size > 0, "Fixture must include unrelated iframe targets");
  const mainId = (await cdp.send("Page.getFrameTree")).frameTree.frame.id;
  const owned = new Map();
  const detaches = [];
  const commands = [];
  const guest = new EventEmitter();
  Object.defineProperty(guest, "mainFrame", {
    get: () => ({
      framesInSubtree: page
        .frames()
        .map((frame, index) => ({ frameTreeNodeId: index, processId: 0, frameToken: frame._guid })),
    }),
  });
  guest.debugger = {
    isAttached: () => true,
    attach() {
      throw new Error("The page session is already attached");
    },
    async sendCommand(method, params = {}, sessionId) {
      commands.push({ method, childSession: Boolean(sessionId), frameId: params.frameId });
      if (method === "Target.getTargets") return discovery.send(method, params);
      if (method === "Target.attachToTarget") {
        assert.ok(
          !foreignTargets.has(params.targetId),
          "Capture must not attach an unrelated page's iframe",
        );
        // Exercise real flat attachment. Playwright manages a second handle for
        // routing commands because its public send API has no sessionId option.
        const attached = await cdp.send(method, params);
        try {
          const { targetInfo } = await cdp.send("Target.getTargetInfo", {
            targetId: params.targetId,
          });
          const frame = page.frames().find((candidate) => candidate.url() === targetInfo.url);
          assert.ok(frame, "Target must belong to this page");
          owned.set(attached.sessionId, await context.newCDPSession(frame));
          return attached;
        } catch (error) {
          await cdp.send("Target.detachFromTarget", { sessionId: attached.sessionId });
          throw error;
        }
      }
      if (method === "Target.detachFromTarget") {
        const child = owned.get(params.sessionId);
        owned.delete(params.sessionId);
        const detached = Promise.all([cdp.send(method, params), child?.detach()]);
        detaches.push(detached);
        await detached;
        return {};
      }
      const owner = sessionId ? owned.get(sessionId) : cdp;
      assert.ok(owner, "Unknown child session");
      const response = await owner.send(method, params);
      if (method === "Page.getFrameTree")
        commands.push({
          tree: JSON.stringify(response.frameTree, (key, value) =>
            ["url", "securityOrigin", "domainAndRegistry"].includes(key) ? undefined : value,
          ),
        });
      if (method === "Runtime.evaluate" && response.exceptionDetails)
        commands.push({ exception: response.exceptionDetails.text });
      return response;
    },
  };
  guest.executeJavaScriptInIsolatedWorld = async (worldId, scripts) => {
    assert.equal(worldId, 1007);
    const world = await cdp.send("Page.createIsolatedWorld", {
      frameId: mainId,
      worldName: "f5-root-snapshot",
    });
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
      contextId: world.executionContextId,
      expression: scripts[0].code,
      returnByValue: true,
    });
    assert.equal(exceptionDetails, undefined, "Root snapshot must evaluate successfully");
    return result.value;
  };
  page.on("framenavigated", () => guest.emit("did-start-navigation"));
  let result;
  try {
    result = await capturePreviewSnapshotPage(guest, {
      consoleEntries: [
        { level: "log", text: secrets.join(" "), timestamp: "2026-10-19T00:00:00Z" },
      ],
      networkEntries: [],
      actionTimeline: [],
    });
  } catch (error) {
    console.error(JSON.stringify(commands, null, 2));
    throw error;
  }
  assert.equal(result.title, "••••••••");
  assert.equal(
    result.interactiveElements.find((element) => element.tag === "button").selector,
    "#••••••••",
  );
  assert.equal(result.visibleText, "x".repeat(19_995) + "•••••");
  for (const secret of secrets) assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(result.consoleEntries[0].text, "•••••••• •••••••• ••••••••");
  for (let attempt = 0; owned.size && attempt < 100; attempt++) await delay(10);
  await Promise.all(detaches);
  assert.equal(owned.size, 0);
  console.log(
    "Chromium CDP snapshot smoke passed: nested cross-origin frames, isolated getters, shadow roots, masked content, pre-truncation redaction, unrelated-page exclusion and owned-session cleanup. Electron runtime integration is a separate check.",
  );
} finally {
  await browser?.close();
  await fixture.close();
  rmSync(directory, { recursive: true, force: true });
}
