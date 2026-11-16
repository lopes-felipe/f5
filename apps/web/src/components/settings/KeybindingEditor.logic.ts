import type { KeybindingCommand } from "@t3tools/contracts";

export interface KeybindingGroup<Row> {
  readonly id: string;
  readonly title: string;
  readonly rows: ReadonlyArray<Row>;
}

/** Editor sections in display order; a command joins the group listing its prefix. */
const KEYBINDING_GROUPS = [
  {
    id: "navigation",
    title: "Navigation",
    prefixes: [
      "navigation",
      "sidebar",
      "rightPanel",
      "commandPalette",
      "palette",
      "projectContentSearch",
      "editor",
      "help",
    ],
  },
  { id: "threads", title: "Threads", prefixes: ["thread", "chat", "prHub", "workflow"] },
  { id: "composer", title: "Composer", prefixes: ["composer", "modelPicker", "model"] },
  { id: "terminal", title: "Terminal", prefixes: ["terminal"] },
  { id: "diff", title: "Diff", prefixes: ["diff"] },
  { id: "usage", title: "Usage", prefixes: ["usage"] },
  { id: "scripts", title: "Project scripts", prefixes: ["script"] },
] as const;
const OTHER_KEYBINDING_GROUP = { id: "other", title: "Other" } as const;

function keybindingGroupFor(command: KeybindingCommand): { id: string; title: string } {
  const prefix = command.split(".")[0] ?? "";
  return (
    KEYBINDING_GROUPS.find((group) => (group.prefixes as ReadonlyArray<string>).includes(prefix)) ??
    OTHER_KEYBINDING_GROUP
  );
}

/** Splits sorted rows into the editor's sections, keeping their order and dropping empty ones. */
export function groupKeybindingRows<Row extends { readonly command: KeybindingCommand }>(
  rows: ReadonlyArray<Row>,
): ReadonlyArray<KeybindingGroup<Row>> {
  const rowsByGroup = new Map<string, Array<Row>>();
  for (const row of rows) {
    const group = keybindingGroupFor(row.command);
    const bucket = rowsByGroup.get(group.id);
    if (bucket) bucket.push(row);
    else rowsByGroup.set(group.id, [row]);
  }
  return [...KEYBINDING_GROUPS, OTHER_KEYBINDING_GROUP].flatMap((group) => {
    const groupRows = rowsByGroup.get(group.id);
    return groupRows ? [{ id: group.id, title: group.title, rows: groupRows }] : [];
  });
}
