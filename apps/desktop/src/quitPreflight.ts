import type { BrowserWindow } from "electron";

/** Let every renderer veto before stopping any backend or handing off an update. */
export async function closeWindowsForQuit(windows: readonly BrowserWindow[]): Promise<boolean> {
  for (const window of windows) {
    if (window.isDestroyed()) continue;
    const contents = window.webContents;
    const closed = await new Promise<boolean>((resolve) => {
      const finish = (result: boolean) => {
        clearTimeout(timer);
        window.removeListener("closed", onClosed);
        contents.removeListener("will-prevent-unload", onVeto);
        resolve(result);
      };
      const onClosed = () => finish(true);
      const onVeto = () => finish(false);
      const timer = setTimeout(onVeto, 10000);
      window.once("closed", onClosed);
      contents.once("will-prevent-unload", onVeto);
      window.close();
    });
    if (!closed) return false;
  }
  return true;
}
