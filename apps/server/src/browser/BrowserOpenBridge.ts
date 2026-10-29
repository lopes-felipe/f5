import type { DesktopComputerHost } from "../computer/DesktopComputerHost";
import { browserOpenEnabled, prepareBrowserOpenLauncher } from "./BrowserOpenLauncher";
import { startBrowserOpenListener } from "./BrowserOpenListener";

/** Optional login support must never prevent profile startup or teardown. */
export async function startBrowserOpenBridge(
  stateDir: string,
  host: Pick<DesktopComputerHost, "openExternalUrl">,
  enabled = browserOpenEnabled(),
  warn: (message: string, error: unknown) => void = console.warn,
): Promise<() => Promise<void>> {
  if (!enabled) return async () => {};
  try {
    const close = await startBrowserOpenListener(stateDir, host);
    return async () => {
      try {
        await close();
      } catch (error) {
        warn("[browser-open] listener cleanup failed", error);
      }
    };
  } catch (error) {
    warn("[browser-open] listener unavailable; copy login URLs manually", error);
    try {
      // Never accidentally connect to an old listener after a failed startup probe.
      await prepareBrowserOpenLauncher(stateDir, null);
    } catch (launcherError) {
      warn("[browser-open] launcher setup failed", launcherError);
    }
    return async () => {};
  }
}
