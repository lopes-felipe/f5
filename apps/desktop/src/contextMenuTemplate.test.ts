import { describe, expect, it, vi } from "vitest";
import { buildContextMenuTemplate } from "./contextMenuTemplate";
import type { MenuItemConstructorOptions } from "electron";

describe("native context menus", () => {
  it("rejects malformed menu input and separates a later destructive section", () => {
    expect(buildContextMenuTemplate(null as never, vi.fn())).toEqual([]);
    const result = buildContextMenuTemplate(
      [
        { id: "rename", label: "Rename", separatorBefore: true },
        { id: "copy", label: "Copy" },
        { id: "delete", label: "Delete", destructive: true },
      ],
      vi.fn(),
    );
    expect(result.map((item) => item.type ?? item.label)).toEqual([
      "Rename",
      "Copy",
      "separator",
      "Delete",
    ]);
  });
  it("preserves nested leaf selection and disabled states", () => {
    const select = vi.fn();
    const template = buildContextMenuTemplate(
      [
        {
          id: "copy",
          label: "Copy",
          children: [
            { id: "path", label: "Path" },
            { id: "branch", label: "Branch", disabled: true },
          ],
        },
      ],
      select,
    );
    const children = template[0]!.submenu as MenuItemConstructorOptions[];
    expect(children[1]!.enabled).toBe(false);
    (children[0]!.click as () => void)();
    expect(select).toHaveBeenCalledWith("path");
  });

  it("keeps archive and delete in one explicit section without leading dividers", () => {
    const template = buildContextMenuTemplate(
      [
        { id: "rename", label: "Rename", separatorBefore: true },
        { id: "archive", label: "Archive", separatorBefore: true },
        { id: "delete", label: "Delete", destructive: true },
      ],
      vi.fn(),
    );
    expect(template.map((item) => item.type ?? item.label)).toEqual([
      "Rename",
      "separator",
      "Archive",
      "Delete",
    ]);
  });
});
