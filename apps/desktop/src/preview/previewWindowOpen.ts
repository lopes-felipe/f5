import type { BrowserWindow, WebContents } from "electron";
export function registerPreviewWindowOpen(
  guest: WebContents,
  owner: BrowserWindow,
  openLink: (url: string) => void,
): void {
  guest.setWindowOpenHandler(({ url, disposition }) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return { action: "deny" };
    }
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password)
      return { action: "deny" };
    if (disposition !== "new-window" || owner.isDestroyed()) {
      openLink(target.href);
      return { action: "deny" };
    }
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        parent: owner,
        width: 520,
        height: 720,
        autoHideMenuBar: true,
        webPreferences: {
          session: guest.session,
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
        },
      },
    };
  });
  guest.on("did-create-window", (child) => {
    child.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const target = new URL(url);
        if (["http:", "https:"].includes(target.protocol)) openLink(target.href);
      } catch {
        /* invalid URL */
      }
      return { action: "deny" };
    });
    child.webContents.on("will-navigate", (event, url) => {
      try {
        if (["http:", "https:"].includes(new URL(url).protocol)) return;
      } catch {
        /* invalid URL */
      }
      event.preventDefault();
    });
    const close = () => {
      if (!child.isDestroyed()) child.destroy();
    };
    owner.once("closed", close);
    guest.once("destroyed", close);
    child.once("closed", () => {
      owner.removeListener("closed", close);
      guest.removeListener("destroyed", close);
    });
  });
}
