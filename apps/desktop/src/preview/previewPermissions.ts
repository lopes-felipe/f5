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
 * disabled.
 */
export const ALLOWED_PREVIEW_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-sanitized-write",
  "fullscreen",
]);

/**
 * Also granted to a local app (a loopback origin) in a tab the user is driving, so the user's
 * own development server can use its camera, location or file pickers. A page the agent is
 * driving, or any other origin, keeps only the permissions above.
 */
export const LOCAL_PREVIEW_PERMISSIONS: ReadonlySet<string> = new Set([
  "media",
  "geolocation",
  "notifications",
  "pointerLock",
  "fileSystem",
  "clipboard-read",
]);

interface PermissionSessionLike {
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
      details?: { readonly requestingUrl?: string },
    ) => void,
  ): void;
  setPermissionCheckHandler(
    handler: (webContents: unknown, permission: string, requestingOrigin?: string) => boolean,
  ): void;
}

function isLoopbackOrigin(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      isLoopbackPreviewHost(parsed.hostname)
    );
  } catch {
    return false;
  }
}

const installedSessions = new WeakSet<object>();

/** Installed once per preview session, before its first guest loads a page. */
export function installPreviewPermissionPolicy(
  session: PermissionSessionLike,
  options: {
    /** Whether the page is in a tab the user, not the agent, is driving. Unknown is not. */
    readonly isUserDriven?: (webContents: unknown) => boolean;
  } = {},
): void {
  if (installedSessions.has(session)) return;
  installedSessions.add(session);
  const allows = (webContents: unknown, permission: string, url: string | undefined) =>
    ALLOWED_PREVIEW_PERMISSIONS.has(permission) ||
    (LOCAL_PREVIEW_PERMISSIONS.has(permission) &&
      isLoopbackOrigin(url) &&
      webContents !== null &&
      options.isUserDriven?.(webContents) === true);
  session.setPermissionRequestHandler((webContents, permission, callback, details) =>
    callback(allows(webContents, permission, details?.requestingUrl)),
  );
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin) =>
    allows(webContents, permission, requestingOrigin),
  );
}
