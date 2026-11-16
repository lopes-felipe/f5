import type { WebContents } from "electron";

const MENU_ACTION_CHANNEL = "desktop:menu-action";

/** Browser editing shortcuts belong to the guest, not the application's menus. */
export function installGuestControls(guest: WebContents): void {
  guest.setIgnoreMenuShortcuts(true);
  guest.on("before-input-event", (event, input) => {
    // Electron's global focused-web-contents lookup can name another guest in
    // the same window. A focused frame distinguishes typing from agent input.
    if (!guest.isFocused() || guest.focusedFrame === null) return;
    if (input.type === "keyDown" && input.key === "F6" && !input.alt) {
      // The renderer runs F6 area focus; its keydown never sees keys sent to the guest.
      const host = guest.hostWebContents;
      if (!host || host.isDestroyed()) return;
      event.preventDefault();
      if (input.isAutoRepeat) return;
      // DOM focus in the renderer cannot by itself release the guest's native keyboard focus.
      host.focus();
      host.send(
        MENU_ACTION_CHANNEL,
        input.shift ? "workspace.focusPrevious" : "workspace.focusNext",
      );
      return;
    }
    if (input.type !== "keyDown" || !(input.control || input.meta) || input.alt) return;
    const key = input.key.toLowerCase();
    const action =
      key === "c"
        ? "copy"
        : key === "x"
          ? "cut"
          : key === "v"
            ? "paste"
            : key === "a"
              ? "selectAll"
              : key === "z"
                ? input.shift
                  ? "redo"
                  : "undo"
                : undefined;
    if (action) {
      event.preventDefault();
      guest[action]();
    }
  });
}
