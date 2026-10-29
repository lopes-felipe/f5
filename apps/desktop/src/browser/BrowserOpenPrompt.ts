import type { BrowserWindow, MessageBoxOptions } from "electron";
import type { BrowserOpenPrompt } from "./BrowserOpenAuthority";

/** Parent consent only to the requesting profile; a parent is required for macOS cancellation. */
export function createBrowserOpenPrompt(effects: {
  window: (profileId: string) => BrowserWindow | undefined;
  openProfile: (profileId: string) => Promise<unknown>;
  profileName: (profileId: string) => string;
  show: (owner: BrowserWindow, options: MessageBoxOptions) => Promise<{ response: number }>;
}): (request: BrowserOpenPrompt) => Promise<number> {
  return async ({ profileId, host, url, signal }) => {
    if (signal.aborted) return 3;
    let owner = effects.window(profileId);
    if (!owner || owner.isDestroyed()) {
      await effects.openProfile(profileId);
      owner = effects.window(profileId);
    }
    if (!owner || owner.isDestroyed() || signal.aborted) return 3;
    owner.show();
    owner.focus();
    return (
      await effects.show(owner, {
        type: "question",
        title: "Open login URL",
        // Native macOS message text is bold; the URL remains in the detail.
        message: host,
        detail: `An agent or terminal in profile "${effects.profileName(profileId)}" wants to open this URL in your browser:\n\n${url.length > 300 ? url.slice(0, 299) + "…" : url}`,
        buttons: ["Open", `Allow ${host} until F5 quits`, "Copy link", "Cancel"],
        defaultId: 0,
        cancelId: 3,
        noLink: true,
        signal,
      })
    ).response;
  };
}
