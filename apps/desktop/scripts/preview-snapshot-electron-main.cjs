const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");
const [modulePath, userData, url, foreignUrl, fixturePath] = process.argv.slice(2);
app.setPath("userData", userData);
app.commandLine.appendSwitch("site-per-process");
app.commandLine.appendSwitch("disable-gpu");
const deadline = setTimeout(() => {
  console.error("Electron snapshot smoke timed out");
  app.exit(1);
}, 30_000);

app
  .whenReady()
  .then(async () => {
    const { capturePreviewSnapshotPage } = require(modulePath);
    const { previewSnapshotSecrets: secrets } = await import(pathToFileURL(fixturePath).href);
    const options = {
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: "snapshot-smoke",
      },
    };
    const window = new BrowserWindow(options);
    const foreign = new BrowserWindow(options);
    const guest = window.webContents;
    try {
      await Promise.all([window.loadURL(url), foreign.loadURL(foreignUrl)]);
      const frames = guest.mainFrame.framesInSubtree;
      assert.equal(frames.length, 3);
      assert.ok(
        new Set(frames.map((frame) => frame.processId)).size >= 2,
        "Fixture must use separate renderer processes",
      );
      const child = frames.find((frame) => new URL(frame.url).pathname === "/child");
      assert.equal(
        await child.executeJavaScript("document.querySelector('input').value"),
        "page-spoof",
      );
      const grandchild = frames.find((frame) => new URL(frame.url).pathname === "/grandchild");
      assert.equal(
        await grandchild.executeJavaScript(
          "document.querySelector('#host').shadowRoot.querySelector('input').value",
        ),
        secrets[1],
      );
      guest.debugger.attach("1.3");
      const { targetInfos } = await guest.debugger.sendCommand("Target.getTargets");
      const foreignIds = new Set(
        targetInfos
          .filter((target) => target.type === "iframe" && target.url.includes("foreign=1"))
          .map((target) => target.targetId),
      );
      assert.ok(foreignIds.size > 0, "Fixture must contain unrelated iframe targets");
      const nativeSend = guest.debugger.sendCommand;
      const owned = new Set();
      const detaches = [];
      let attachments = 0;
      guest.debugger.sendCommand = async function (method, params, sessionId) {
        if (method === "Target.attachToTarget") {
          assert.ok(!foreignIds.has(params.targetId), "Unrelated iframe must never be attached");
          const result = await nativeSend.call(this, method, params, sessionId);
          owned.add(result.sessionId);
          attachments++;
          return result;
        }
        if (method === "Target.detachFromTarget") {
          const result = nativeSend
            .call(this, method, params, sessionId)
            .finally(() => owned.delete(params.sessionId));
          detaches.push(result);
          return result;
        }
        return nativeSend.call(this, method, params, sessionId);
      };
      try {
        const result = await capturePreviewSnapshotPage(guest, {
          consoleEntries: [
            { level: "log", text: secrets.join(" "), timestamp: "2026-10-19T00:00:00Z" },
          ],
          networkEntries: [],
          actionTimeline: [],
        });
        assert.equal(result.title, "••••••••");
        assert.equal(
          result.interactiveElements.find((element) => element.tag === "button").selector,
          "#••••••••",
        );
        assert.equal(result.visibleText, "x".repeat(19_995) + "•••••");
        assert.equal(result.consoleEntries[0].text, "•••••••• •••••••• ••••••••");
        for (const secret of secrets) assert.ok(!JSON.stringify(result).includes(secret));
        await Promise.all(detaches);
        assert.equal(owned.size, 0);
        assert.ok(guest.debugger.isAttached(), "Shared root debugger must remain attached");
        console.log(
          JSON.stringify({
            electron: process.versions.electron,
            nativeFrames: frames.length,
            rendererProcesses: new Set(frames.map((frame) => frame.processId)).size,
            childAttachments: attachments,
            passed: true,
          }),
        );
      } finally {
        guest.debugger.sendCommand = nativeSend;
      }
    } finally {
      window.destroy();
      foreign.destroy();
    }
  })
  .then(
    () => {
      clearTimeout(deadline);
      app.exit(0);
    },
    (error) => {
      console.error(error.stack);
      clearTimeout(deadline);
      app.exit(1);
    },
  );
