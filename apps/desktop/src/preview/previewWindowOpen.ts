import type { BrowserWindow, WebContents } from "electron";

/**
 * The parent tab's live navigation policy. Popups opened while the agent drives the tab
 * are bound to it for their whole lifetime; popups the user opens stay with the user.
 */
export interface PreviewPopupPolicy {
  /** True for a navigation the agent caused (during an action or its grace window). */
  readonly isAgentNavigation: () => boolean;
  /** Checks the parent tab's current allowed-sites list. */
  readonly isAllowedUrl: (url: string) => boolean;
  /** Records an agent navigation that was refused, so the agent's action fails. */
  readonly onBlocked: (url: string) => void;
}

export interface PreviewPopupController {
  /** Closes agent popups whose page is no longer allowed (after a policy change). */
  readonly enforcePolicy: () => void;
}

function httpUrl(url: string): URL | null {
  try {
    const target = new URL(url);
    return ["http:", "https:"].includes(target.protocol) ? target : null;
  } catch {
    return null;
  }
}

export function registerPreviewWindowOpen(
  guest: WebContents,
  owner: BrowserWindow,
  openLink: (url: string) => void,
  onPopupCountChange?: (delta: 1 | -1) => void,
  policy?: PreviewPopupPolicy,
): PreviewPopupController {
  const agentPopups = new Set<BrowserWindow>();
  // Set by the open handler and consumed by the matching `did-create-window`.
  let nextPopupIsAgent = false;
  guest.setWindowOpenHandler(({ url, disposition }) => {
    const target = httpUrl(url);
    if (!target || target.username || target.password) return { action: "deny" };
    const agent = policy?.isAgentNavigation() ?? false;
    if (agent && !policy!.isAllowedUrl(target.href)) {
      // Agent-driven popups never escape to the system browser or an unapproved site.
      policy!.onBlocked(target.href);
      return { action: "deny" };
    }
    if (disposition !== "new-window" || owner.isDestroyed()) {
      if (!agent) openLink(target.href);
      return { action: "deny" };
    }
    nextPopupIsAgent = agent;
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
    const agent = nextPopupIsAgent && policy !== undefined;
    nextPopupIsAgent = false;
    if (agent) agentPopups.add(child);
    const refuse = (url: string): boolean => {
      const target = httpUrl(url);
      if (!target) return true;
      if (!agent || policy!.isAllowedUrl(target.href)) return false;
      policy!.onBlocked(target.href);
      return true;
    };
    child.webContents.setWindowOpenHandler(({ url }) => {
      const target = httpUrl(url);
      if (target && !agent) openLink(target.href);
      return { action: "deny" };
    });
    child.webContents.on("will-navigate", (event, url) => {
      if (refuse(url)) event.preventDefault();
    });
    if (agent) {
      child.webContents.on("will-redirect", (details) => {
        if (details.isMainFrame && refuse(details.url)) details.preventDefault();
      });
      child.webContents.on("did-start-navigation", (details) => {
        if (details.isMainFrame && !details.isSameDocument && refuse(details.url)) {
          child.webContents.stop();
        }
      });
    }
    const close = () => {
      if (!child.isDestroyed()) child.destroy();
    };
    owner.once("closed", close);
    guest.once("destroyed", close);
    onPopupCountChange?.(1);
    child.once("closed", () => {
      agentPopups.delete(child);
      onPopupCountChange?.(-1);
      owner.removeListener("closed", close);
      guest.removeListener("destroyed", close);
    });
  });
  return {
    enforcePolicy: () => {
      for (const child of agentPopups) {
        if (child.isDestroyed()) continue;
        const url = child.webContents.getURL();
        if (url && url !== "about:blank" && !policy?.isAllowedUrl(url)) child.destroy();
      }
    },
  };
}
