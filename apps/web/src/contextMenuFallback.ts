import type { ContextMenuItem } from "@t3tools/contracts";
import { createIconElement } from "./contextMenuIcons";

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
    const levels: Array<{ menu: HTMLDivElement; trigger?: HTMLButtonElement }> = [{ menu }];
    const closeAfter = (level: number) => {
      while (levels.length > level + 1) {
        const child = levels.pop()!;
        child.trigger?.setAttribute("aria-expanded", "false");
        child.menu.remove();
      }
    };
    const containsFocus = () => levels.some(({ menu }) => menu.contains(document.activeElement));

    let disposed = false;
    function cleanup(result: T | null, restoreFocus = true) {
      if (disposed) return;
      disposed = true;
      if (activeDismiss === dismiss) activeDismiss = null;
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("blur", onWindowBlur);
      // Focus goes back to the row behind the menu only if the menu still holds it.
      const shouldRestoreFocus = restoreFocus && containsFocus();
      closeAfter(0);
      overlay.remove();
      menu.remove();
      if (shouldRestoreFocus && opener?.isConnected) opener.focus({ preventScroll: true });
      resolve(result);
    }
    const dismiss = (restoreFocus: boolean) => cleanup(null, restoreFocus);

    const enabledItems = (container = levels.at(-1)!.menu) =>
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(
        (button) => !button.disabled,
      );

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cleanup(null);
        return;
      }
      if (!containsFocus() || e.isComposing) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const currentLevel = levels.findIndex(({ menu }) => menu.contains(document.activeElement));
      const buttons = enabledItems(levels[currentLevel]!.menu);
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      let target: HTMLButtonElement | undefined;
      switch (e.key) {
        case "ArrowRight":
          if ((document.activeElement as HTMLElement).getAttribute("aria-haspopup") !== "menu")
            return;
          (document.activeElement as HTMLButtonElement).click();
          e.preventDefault();
          e.stopPropagation();
          return;
        case "ArrowLeft": {
          if (currentLevel === 0) return;
          const trigger = levels[currentLevel]!.trigger;
          closeAfter(currentLevel - 1);
          trigger?.focus({ preventScroll: true });
          e.preventDefault();
          e.stopPropagation();
          return;
        }
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
      if (!levels.some(({ menu }) => menu.contains(event.target as Node))) cleanup(null, false);
    };
    const onWindowBlur = () => cleanup(null, false);

    overlay.addEventListener("mousedown", () => cleanup(null));

    const populate = (
      entries: readonly ContextMenuItem<T>[],
      container: HTMLDivElement,
      level: number,
    ) => {
      for (const item of entries) {
        if (item.separatorBefore && container.childElementCount > 0) {
          const separator = document.createElement("div");
          separator.setAttribute("role", "separator");
          separator.className = "my-1 border-t border-border";
          container.appendChild(separator);
        }
        const btn = document.createElement("button");
        btn.type = "button";
        if (item.icon) {
          const icon = createIconElement(item.icon, item.destructive ? "destructive" : "neutral");
          if (icon) {
            icon.setAttribute("aria-hidden", "true");
            btn.appendChild(icon);
          }
        }
        const label = document.createElement("span");
        label.textContent = item.label;
        btn.appendChild(label);
        btn.setAttribute("role", "menuitem");
        btn.tabIndex = -1;
        btn.disabled = item.disabled === true;
        btn.addEventListener("focus", () => closeAfter(level));
        btn.addEventListener("mouseenter", () => {
          if (!btn.disabled) btn.focus({ preventScroll: true });
        });
        const isDestructiveAction = item.destructive === true || item.id === "delete";
        btn.className = isDestructiveAction
          ? "flex w-full items-center gap-2 px-3 py-1.5 text-left text-2xs text-destructive outline-none hover:bg-accent focus-visible:bg-accent cursor-default"
          : "flex w-full items-center gap-2 px-3 py-1.5 text-left text-2xs text-popover-foreground outline-none hover:bg-accent focus-visible:bg-accent cursor-default";
        if (item.disabled) {
          btn.className =
            "flex w-full items-center gap-2 px-3 py-1.5 text-left text-2xs text-muted-foreground cursor-default";
        }
        if (item.children?.length) {
          btn.setAttribute("aria-haspopup", "menu");
          btn.setAttribute("aria-expanded", "false");
          const chevron = createIconElement("chevron-right", "neutral");
          if (chevron) {
            chevron.setAttribute("aria-hidden", "true");
            btn.appendChild(chevron);
          }
          const open = (focus: boolean) => {
            if (btn.disabled || level >= 8) return;
            closeAfter(level);
            const child = document.createElement("div");
            child.className = menu.className;
            child.setAttribute("role", "menu");
            child.setAttribute("aria-label", item.label);
            const rect = btn.getBoundingClientRect();
            populate(item.children!, child, level + 1);
            document.body.appendChild(child);
            levels.push({ menu: child, trigger: btn });
            btn.setAttribute("aria-expanded", "true");
            const bounds = child.getBoundingClientRect();
            child.style.left = `${Math.max(4, rect.right + bounds.width > window.innerWidth ? rect.left - bounds.width : rect.right)}px`;
            child.style.top = `${Math.max(4, Math.min(rect.top, window.innerHeight - bounds.height - 4))}px`;
            if (focus) enabledItems(child)[0]?.focus({ preventScroll: true });
          };
          btn.addEventListener("click", () => open(true));
          btn.addEventListener("mouseenter", () => open(false));
        } else {
          btn.addEventListener("mouseenter", () => closeAfter(level));
          btn.addEventListener("click", () => cleanup(item.id));
        }
        container.appendChild(btn);
      }
    };
    populate(items, menu, 0);

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
