const pinnedDebuggers = new WeakMap<object, Electron.Debugger>();

/**
 * The guest's Debugger, pinned for as long as the guest lives. Electron's Debugger is
 * GC-managed but registered with Chromium as a raw client pointer, so collecting it while
 * attached crashes the browser process (electron/electron#53376). Detaching through the pinned
 * reference also works after the guest is destroyed, when `guest.debugger` throws.
 */
export function previewDebugger(guest: Pick<Electron.WebContents, "debugger">): Electron.Debugger {
  let pinned = pinnedDebuggers.get(guest);
  if (!pinned) {
    pinned = guest.debugger;
    pinnedDebuggers.set(guest, pinned);
  }
  return pinned;
}
