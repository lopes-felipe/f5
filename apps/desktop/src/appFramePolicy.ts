/**
 * Guards for the frames the app renderer embeds: HTML renders and MCP apps, which run agent- or
 * server-supplied pages in `srcdoc` iframes.
 *
 * Their CSP limits subresources but not navigation, so without this a page could carry its
 * contents out with `location.href = "https://…?d=…"` or a meta refresh. A `srcdoc` frame may
 * load its own document and nothing else; links reach the browser through the frame's bridge.
 *
 * Frames are remembered by identity, not by their current URL: a page can change its URL first
 * (a fragment, or `about:blank`) and navigate away from there. Frames nested in a protected frame
 * are protected too.
 */
export function createEmbeddedFrameNavigationGuard() {
  const protectedFrames = new Set<number>();
  return (input: {
    readonly isMainFrame: boolean;
    readonly isSameDocument: boolean;
    /** The navigating frame's id, then its ancestors' (Electron's `frameTreeNodeId`). */
    readonly frameIds: ReadonlyArray<number>;
    /** The frame's current URL, before this navigation. */
    readonly frameUrl: string | undefined;
    readonly url: string;
  }): boolean => {
    if (input.isMainFrame) return false;
    const [frameId] = input.frameIds;
    const isProtected =
      input.frameIds.some((id) => protectedFrames.has(id)) ||
      (input.frameUrl !== undefined && withoutFragment(input.frameUrl) === "about:srcdoc");
    if (!isProtected) return false;
    if (frameId !== undefined) protectedFrames.add(frameId);
    if (input.isSameDocument) return false;
    const target = withoutFragment(input.url);
    return target !== "about:srcdoc" && target !== "about:blank";
  };
}

function withoutFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

/**
 * Permissions an embedded frame may use. Electron approves every request when a session has no
 * handler, so an MCP app could otherwise use the camera, microphone or location as F5 without a
 * prompt. The app's own top-level page keeps every permission, as before.
 */
export const ALLOWED_EMBEDDED_FRAME_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-sanitized-write",
  "fullscreen",
]);

interface FramePermissionDetails {
  readonly isMainFrame?: boolean;
}

interface AppPermissionSessionLike {
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
      details: FramePermissionDetails,
    ) => void,
  ): void;
  setPermissionCheckHandler(
    handler: (
      webContents: unknown,
      permission: string,
      requestingOrigin: string,
      details: FramePermissionDetails,
    ) => boolean,
  ): void;
}

export function allowsAppPermission(permission: string, details: FramePermissionDetails): boolean {
  return details.isMainFrame !== false || ALLOWED_EMBEDDED_FRAME_PERMISSIONS.has(permission);
}

const installedSessions = new WeakSet<object>();

/** Installed once per app renderer session, before its first window loads. */
export function installAppFramePermissionPolicy(session: AppPermissionSessionLike): void {
  if (installedSessions.has(session)) return;
  installedSessions.add(session);
  session.setPermissionRequestHandler((_webContents, permission, callback, details) =>
    callback(allowsAppPermission(permission, details)),
  );
  session.setPermissionCheckHandler((_webContents, permission, _origin, details) =>
    allowsAppPermission(permission, details),
  );
}
