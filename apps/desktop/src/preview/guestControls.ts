import type { WebContents } from "electron";
/** Browser editing shortcuts belong to the guest, not the application's menus. */
export function installGuestControls(guest: WebContents): void {
  guest.setIgnoreMenuShortcuts(true);
  guest.on("before-input-event", (event, input) => {
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
