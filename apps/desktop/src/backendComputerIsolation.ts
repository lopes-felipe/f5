/** macOS attributes GUI permissions to F5's responsible-process tree. Apply a
 * kernel sandbox to every backend subtree, even when computer use is disabled:
 * SnapShot and other profiles may already have granted F5 those permissions.
 * Main and its authorized helper stay outside this sandbox. Filesystem and
 * network coding tools keep their existing behavior; shell GUI automation must
 * use the consent-mediated computer catalog instead.
 */
export const MAC_BACKEND_COMPUTER_SANDBOX = String.raw`(version 1)
(allow default)
(deny appleevent-send)
(deny hid-control)
(deny job-creation)
(deny lsopen)
(deny mach-priv-task-port)
(deny mach-lookup
  (global-name-regex #"^com\.apple\.(windowserver|WindowServer|tccd|accessibility|axserver|AXRuntime|replayd|screencapture|ScreenCaptureKit|CARenderServer|coreservices\.(appleevents|launchservices))"))`;

export function isolatedBackendCommand(
  platform: string,
  executable: string,
  entry: string,
  nodeArgs: ReadonlyArray<string> = [],
) {
  return platform === "darwin"
    ? {
        executable: "/usr/bin/sandbox-exec",
        args: ["-p", MAC_BACKEND_COMPUTER_SANDBOX, executable, ...nodeArgs, entry],
      }
    : { executable, args: [...nodeArgs, entry] };
}
