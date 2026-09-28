import { app, BrowserWindow, ipcMain, Notification, type WebContents } from "electron";
import type { QuitShortcutMode } from "@t3tools/contracts";
import { makeQuitShortcutHandler } from "./quitHold";

/** One handler spans all web contents, including guests, OAuth windows and DevTools. */
export function installDesktopAttention(profileForRenderer: (id: number) => string | undefined) {
  const modes = new Map<string, QuitShortcutMode>();
  const badges = new Map<string, Map<number, number>>();
  let source: WebContents | undefined;
  let lastProfile: string | undefined;
  let nativeHint: Notification | undefined;
  let hintOwner: WebContents | undefined;
  const refreshBadge = () => {
    // Several windows can show the same profile. Count that profile only once.
    app.setBadgeCount(
      [...badges.values()].reduce((sum, counts) => sum + Math.max(0, ...counts.values()), 0),
    );
  };
  const handle = makeQuitShortcutHandler({
    platform: process.platform,
    getMode: async () => {
      const profile = source && profileForRenderer(source.id);
      if (profile) lastProfile = profile;
      return (lastProfile && modes.get(lastProfile)) || "hold";
    },
    notify: (hint) => {
      if (hintOwner && !hintOwner.isDestroyed())
        hintOwner.send("desktop:quit-hint", { state: "up" });
      hintOwner = undefined;
      nativeHint?.close();
      nativeHint = undefined;
      if (
        hint.state === "down" &&
        source &&
        !source.isDestroyed() &&
        profileForRenderer(source.id)
      ) {
        hintOwner = source;
        source.send("desktop:quit-hint", hint);
      } else if (hint.state === "down" && Notification.isSupported()) {
        const shortcut = process.platform === "darwin" ? "⌘Q" : "Ctrl+Q";
        nativeHint = new Notification({
          title: "Quit F5",
          body:
            hint.mode === "hold"
              ? `Hold ${shortcut} or press twice to quit`
              : `Press ${shortcut} again to quit`,
          silent: true,
        });
        nativeHint.show();
      }
    },
    concealWindow: () => {
      for (const window of BrowserWindow.getAllWindows()) window.hide();
    },
    quit: () => app.quit(),
  });
  app.on("browser-window-focus", (_event, window) => {
    const profile = profileForRenderer(window.webContents.id);
    if (profile) lastProfile = profile;
  });
  app.on("web-contents-created", (_event, contents) => {
    contents.on("before-input-event", (event, input) => {
      source = contents;
      handle(event, input);
    });
    contents.once("destroyed", () => {
      for (const counts of badges.values()) counts.delete(contents.id);
      refreshBadge();
    });
  });
  const authorize = (event: Electron.IpcMainInvokeEvent) => {
    const profile = profileForRenderer(event.sender.id);
    if (!profile || event.senderFrame !== event.sender.mainFrame)
      throw new Error("Untrusted renderer");
    return profile;
  };
  ipcMain.handle("desktop:quit-mode", (event, mode: unknown) => {
    const profile = authorize(event);
    if (mode !== "hold" && mode !== "double-click" && mode !== "direct")
      throw new Error("Invalid quit mode");
    modes.set(profile, mode);
  });
  ipcMain.handle("desktop:attention-badge", (event, count: unknown) => {
    const profile = authorize(event);
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
      throw new Error("Invalid badge count");
    const counts = badges.get(profile) ?? new Map<number, number>();
    counts.set(event.sender.id, count);
    badges.set(profile, counts);
    refreshBadge();
  });
}
