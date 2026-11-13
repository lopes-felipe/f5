import type { ContextMenuItem } from "@t3tools/contracts";
import type { MenuItemConstructorOptions } from "electron";

/** Icons remain renderer-owned; native menus share the same sections and hierarchy. */
export function buildContextMenuTemplate(
  entries: readonly ContextMenuItem[],
  select: (id: string) => void,
  destructiveIcon?: MenuItemConstructorOptions["icon"],
  depth = 0,
): MenuItemConstructorOptions[] {
  if (depth > 8) return [];
  const template: MenuItemConstructorOptions[] = [];
  let explicitSection = false;
  let destructiveSection = false;
  for (const item of entries) {
    if (typeof item.id !== "string" || typeof item.label !== "string") continue;
    if (item.separatorBefore) explicitSection = true;
    if (
      template.length > 0 &&
      (item.separatorBefore || (item.destructive && !destructiveSection && !explicitSection))
    )
      template.push({ type: "separator" });
    if (item.destructive) destructiveSection = true;
    const children =
      Array.isArray(item.children) && item.children.length > 0
        ? buildContextMenuTemplate(item.children, select, destructiveIcon, depth + 1)
        : undefined;
    template.push({
      label: item.label,
      enabled: item.disabled !== true,
      ...(item.destructive && destructiveIcon ? { icon: destructiveIcon } : {}),
      ...(children ? { submenu: children } : { click: () => select(item.id) }),
    });
  }
  return template;
}
