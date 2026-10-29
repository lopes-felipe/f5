import type { ContextMenuItem } from "@t3tools/contracts";

let activeDismiss: ((restoreFocus: boolean) => void) | null = null;

/** Closes an open renderer context menu; `restoreFocus` returns focus to its opener. */
export function dismissContextMenuFallback(restoreFocus = true): void {
  activeDismiss?.(restoreFocus);
}

/**
 * Imperative renderer-owned context menu. This is also useful in Electron
 * when an action must retain Chromium's transient user activation.
 * Resolves with the clicked item id, or null if dismissed.
 */
export function showContextMenuFallback<T extends string>(
  items: readonly ContextMenuItem<T>[],
  position?: { x: number; y: number },
): Promise<T | null> {
  // Only one menu at a time; replacing it must not leak its DOM or listeners.
  dismissContextMenuFallback(false);
  return new Promise<T | null>((resolve) => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:9999";

    const menu = document.createElement("div");
    menu.className =
      "fixed z-[10000] min-w-[140px] rounded-md border border-border bg-popover py-1 shadow-xl outline-none animate-in fade-in zoom-in-95";

    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Context menu");
    menu.tabIndex = -1;
    const x = position?.x ?? 0;
    const y = position?.y ?? 0;
    menu.style.top = `${y}px`;
    menu.style.left = `${x}px`;

    let disposed = false;
    function cleanup(result: T | null, restoreFocus = true) {
      if (disposed) return;
      disposed = true;
      if (activeDismiss === dismiss) activeDismiss = null;
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("blur", onWindowBlur);
      // Focus goes back to the row behind the menu only if the menu still holds it.
      const shouldRestoreFocus = restoreFocus && menu.contains(document.activeElement);
      overlay.remove();
      menu.remove();
      if (shouldRestoreFocus && opener?.isConnected) opener.focus({ preventScroll: true });
      resolve(result);
    }
    const dismiss = (restoreFocus: boolean) => cleanup(null, restoreFocus);

    const enabledItems = () =>
      Array.from(menu.querySelectorAll<HTMLButtonElement>("button")).filter(
        (button) => !button.disabled,
      );

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cleanup(null);
        return;
      }
      if (!menu.contains(document.activeElement) || e.isComposing) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const buttons = enabledItems();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      let target: HTMLButtonElement | undefined;
      switch (e.key) {
        case "ArrowDown":
          target = buttons[(index + 1) % buttons.length];
          break;
        case "ArrowUp":
          target = buttons[((index < 0 ? 0 : index) - 1 + buttons.length) % buttons.length];
          break;
        case "Home":
          target = buttons[0];
          break;
        case "End":
          target = buttons.at(-1);
          break;
        case "Tab":
          // Tab closes the menu and continues from the element that opened it.
          cleanup(null);
          return;
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
      target?.focus({ preventScroll: true });
    }
    // Focus leaving the menu (F6, a click elsewhere, another window) closes it in place.
    const onFocusIn = (event: FocusEvent) => {
      if (!menu.contains(event.target as Node)) cleanup(null, false);
    };
    const onWindowBlur = () => cleanup(null, false);

    overlay.addEventListener("mousedown", () => cleanup(null));

    for (const item of items) {
      if (item.separatorBefore && menu.childElementCount > 0) {
        const separator = document.createElement("div");
        separator.setAttribute("role", "separator");
        separator.className = "my-1 border-t border-border";
        menu.appendChild(separator);
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = item.label;
      btn.setAttribute("role", "menuitem");
      btn.tabIndex = -1;
      btn.disabled = item.disabled === true;
      const isDestructiveAction = item.destructive === true || item.id === "delete";
      btn.className = isDestructiveAction
        ? "flex w-full items-center gap-2 px-3 py-1.5 text-left text-2xs text-destructive outline-none hover:bg-accent focus-visible:bg-accent cursor-default"
        : "flex w-full items-center gap-2 px-3 py-1.5 text-left text-2xs text-popover-foreground outline-none hover:bg-accent focus-visible:bg-accent cursor-default";
      if (item.disabled) {
        btn.className =
          "flex w-full items-center gap-2 px-3 py-1.5 text-left text-2xs text-muted-foreground cursor-default";
      }
      btn.addEventListener("click", () => cleanup(item.id));
      menu.appendChild(btn);
    }

    document.body.appendChild(overlay);
    document.body.appendChild(menu);
    activeDismiss = dismiss;

    // A keyboard-opened menu starts on its first action, a pointer-opened one on the menu
    // itself. Text fields always match :focus-visible, so they say nothing about how it opened.
    const keyboardOpened =
      opener?.matches(":focus-visible") === true &&
      !opener.matches('input, textarea, select, [contenteditable="true"]');
    ((keyboardOpened ? enabledItems()[0] : undefined) ?? menu).focus({ preventScroll: true });
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn);
    window.addEventListener("blur", onWindowBlur);

    // Adjust if menu overflows viewport
    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        menu.style.left = `${window.innerWidth - rect.width - 4}px`;
      }
      if (rect.bottom > window.innerHeight) {
        menu.style.top = `${window.innerHeight - rect.height - 4}px`;
      }
    });
  });
}
