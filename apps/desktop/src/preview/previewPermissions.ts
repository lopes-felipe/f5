import { isLoopbackPreviewHost } from "@t3tools/shared/preview";

/**
 * Permissions a preview page may use. Preview tabs run untrusted pages, and Electron approves
 * every request when a session has no handler, so without this a page could read the
 * clipboard, post notifications, ask for location, camera or microphone as F5, or launch
 * an app through a custom scheme (`openExternal`).
 *
 * `clipboard-sanitized-write` backs `navigator.clipboard.writeText()`, so a page's Copy
 * buttons work; the check handler gates it too, so both handlers allow it. `fullscreen`
 * fills the preview's own webview, since guests attach with HTML fullscreen window resizing
 * disabled. `loopback-network` is allowed only by the check handler, so sign-in widgets can
 * query permission before contacting
 * local authenticators. Electron 44.10.1 disables LocalNetworkAccessChecks in its
 * shell/browser/feature_list.cc, so this reflects existing network access rather than
 * expanding it. Reassess this grant if that Electron default changes on upgrade.
 */
export const ALLOWED_PREVIEW_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-sanitized-write",
  "fullscreen",
]);

/**
 * Also granted to a local app (a loopback origin) in a tab the user is driving, so the user's
 * own development server can use its camera or file pickers. Location additionally requires
 * consent. A page the agent is driving, or any other origin, keeps only the permissions above.
 */
export const LOCAL_PREVIEW_PERMISSIONS: ReadonlySet<string> = new Set([
  "media",
  "pointerLock",
  "fileSystem",
  "clipboard-read",
]);

interface PermissionSessionLike<Contents> {
  setPermissionRequestHandler(
    handler: (
      webContents: Contents,
      permission: string,
      callback: (granted: boolean) => void,
      details?: { readonly requestingUrl?: string },
    ) => void,
  ): void;
  setPermissionCheckHandler(
    handler: (
      webContents: Contents | null,
      permission: string,
      requestingOrigin?: string,
    ) => boolean,
  ): void;
}

function loopbackOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      isLoopbackPreviewHost(parsed.hostname)
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

const installedSessions = new WeakSet<object>();
// Keep pages from stacking native location dialogs across origins or profiles.
let activeGeolocationPrompt:
  | {
      readonly session: object;
      readonly origin: string;
      readonly result: Promise<boolean | undefined>;
    }
  | undefined;

/** Installed once per preview session, before its first guest loads a page. */
export function installPreviewPermissionPolicy<Contents>(
  session: PermissionSessionLike<Contents>,
  options: {
    /** Whether the page is in a tab the user, not the agent, is driving. Unknown is not. */
    readonly isUserDriven?: (webContents: Contents) => boolean;
    /** Undefined means the prompt could not be presented. */
    readonly confirmGeolocation?: (
      webContents: Contents,
      origin: string,
    ) => Promise<boolean | undefined>;
  } = {},
): void {
  if (installedSessions.has(session)) return;
  installedSessions.add(session);
  const geolocationDecisions = new Map<string, boolean>();
  const isUserDriven = (webContents: Contents | null): webContents is Contents =>
    webContents !== null && options.isUserDriven?.(webContents) === true;
  const allows = (webContents: Contents | null, permission: string, url: string | undefined) =>
    ALLOWED_PREVIEW_PERMISSIONS.has(permission) ||
    (LOCAL_PREVIEW_PERMISSIONS.has(permission) &&
      loopbackOrigin(url) !== null &&
      isUserDriven(webContents));

  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission !== "geolocation") {
      callback(allows(webContents, permission, details?.requestingUrl));
      return;
    }
    // An opaque frame URL cannot establish an origin eligible for consent.
    const origin = loopbackOrigin(details?.requestingUrl);
    if (origin === null || !isUserDriven(webContents)) {
      callback(false);
      return;
    }
    const remembered = geolocationDecisions.get(origin);
    if (remembered !== undefined) {
      callback(remembered);
      return;
    }
    const active = activeGeolocationPrompt;
    if (active && (active.session !== session || active.origin !== origin)) {
      callback(false);
      return;
    }
    let prompt = active?.result;
    if (prompt === undefined) {
      prompt = Promise.resolve()
        .then(() =>
          isUserDriven(webContents) ? options.confirmGeolocation?.(webContents, origin) : undefined,
        )
        .catch(() => undefined)
        .then((decision) => {
          activeGeolocationPrompt = undefined;
          if (decision !== undefined) geolocationDecisions.set(origin, decision);
          return decision;
        });
      activeGeolocationPrompt = { session, origin, result: prompt };
    }
    void prompt.then((decision) => callback(decision === true && isUserDriven(webContents)));
  });
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    if (permission === "geolocation") {
      const origin = loopbackOrigin(requestingOrigin);
      return (
        origin !== null && geolocationDecisions.get(origin) === true && isUserDriven(webContents)
      );
    }
    // The pinned Electron disables LNA enforcement. An upgrade regression test forces
    // reassessment: a granted check can itself authorize APIs without a later request.
    return permission === "loopback-network" || allows(webContents, permission, requestingOrigin);
  });
}
