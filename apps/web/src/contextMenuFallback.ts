import type { ContextMenuItem } from "@t3tools/contracts";

/**
 * Imperative renderer-owned context menu. This is also useful in Electron
 * when an action must retain Chromium's transient user activation.
 * Resolves with the clicked item id, or null if dismissed.
 */
export function showContextMenuFallback<T extends string>(
  items: readonly ContextMenuItem<T>[],
  position?: { x: number; y: number },
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:9999";

    const menu = document.createElement("div");
    menu.className =
      "fixed z-[10000] min-w-[140px] rounded-md border border-border bg-popover py-1 shadow-xl animate-in fade-in zoom-in-95";

    menu.setAttribute("role", "menu");
    const x = position?.x ?? 0;
    const y = position?.y ?? 0;
    menu.style.top = `${y}px`;
    menu.style.left = `${x}px`;

    function cleanup(result: T | null) {
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      menu.remove();
      resolve(result);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup(null);
      }
    }

    overlay.addEventListener("mousedown", () => cleanup(null));
    document.addEventListener("keydown", onKeyDown);

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
      btn.disabled = item.disabled === true;
      const isDestructiveAction = item.destructive === true || item.id === "delete";
      btn.className = isDestructiveAction
        ? "flex w-full items-center gap-2 px-3 py-1.5 text-left text-2xs text-destructive hover:bg-accent cursor-default"
        : "flex w-full items-center gap-2 px-3 py-1.5 text-left text-2xs text-popover-foreground hover:bg-accent cursor-default";
      if (item.disabled) {
        btn.className =
          "flex w-full items-center gap-2 px-3 py-1.5 text-left text-2xs text-muted-foreground cursor-default";
      }
      btn.addEventListener("click", () => cleanup(item.id));
      menu.appendChild(btn);
    }

    document.body.appendChild(overlay);
    document.body.appendChild(menu);

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
