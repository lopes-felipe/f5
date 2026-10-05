import {
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
  STATIC_KEYBINDING_COMMANDS,
  type KeybindingCommand,
  type KeybindingWhenNode,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { formatShortcutLabel } from "@t3tools/shared/keybindings";

import { shortcutBindingForCommand } from "../keybindings";
import { formatKeybindingCommandLabel } from "../lib/keybindingConflicts";

type StaticKeybindingCommand = (typeof STATIC_KEYBINDING_COMMANDS)[number];

export interface ShortcutEntry {
  readonly command: StaticKeybindingCommand;
  readonly label: string;
  readonly shortcut: string;
  /** Where the shortcut applies, when it only works in one place. */
  readonly context: string | null;
}

/**
 * Context keys worth naming in the reference. Several shortcuts share a key
 * and differ only by where focus is (⌘N is a new thread, or a new terminal
 * when the terminal is focused), so the context tells them apart.
 */
const WHEN_CONTEXT_LABELS: Readonly<Record<string, string>> = {
  terminalFocus: "In terminal",
  dialogFocus: "In dialogs",
  composerFocus: "In composer",
  modelPickerOpen: "In model picker",
};

/** Context keys the clause requires to be true (ignores negated and `or` branches). */
function requiredWhenIdentifiers(node: KeybindingWhenNode | undefined): string[] {
  if (!node) return [];
  if (node.type === "identifier") return [node.name];
  if (node.type === "and") {
    return [...requiredWhenIdentifiers(node.left), ...requiredWhenIdentifiers(node.right)];
  }
  return [];
}

export function shortcutContextLabel(node: KeybindingWhenNode | undefined): string | null {
  for (const identifier of requiredWhenIdentifiers(node)) {
    const label = WHEN_CONTEXT_LABELS[identifier];
    if (label) return label;
  }
  return null;
}

export interface ShortcutSection {
  readonly id: string;
  readonly title: string;
  readonly entries: ReadonlyArray<ShortcutEntry>;
}

const SHORTCUT_SECTION_DEFINITIONS: ReadonlyArray<{
  readonly id: string;
  readonly title: string;
  readonly commands: ReadonlyArray<StaticKeybindingCommand>;
}> = [
  {
    id: "general",
    title: "General",
    commands: [
      "commandPalette.toggle",
      "help.shortcuts",
      "palette.files",
      "projectContentSearch.toggle",
      "sidebar.toggle",
      "prHub.open",
      "editor.openFavorite",
      "dialog.primaryAction",
    ],
  },
  {
    id: "navigation",
    title: "Navigation",
    commands: [
      "navigation.back",
      "navigation.forward",
      "thread.switchRecentNext",
      "thread.switchRecentPrevious",
      "chat.pageUp",
      "chat.pageDown",
      "chat.scrollToBottom",
    ],
  },
  {
    id: "threads",
    title: "Threads",
    commands: [
      "chat.new",
      "chat.newLocal",
      "chat.newBackground",
      "workflow.new",
      "thread.stop",
      "thread.togglePin",
      "thread.copyReference",
      "thread.undo",
      "prHub.copyNumber",
    ],
  },
  {
    id: "composer",
    title: "Composer",
    commands: [
      "chat.queueTurn",
      "chat.queueTurnNext",
      "chat.steerTurn",
      "composer.stash",
      "composer.pasteAsText",
      "composer.effort",
      "composer.runtimeMode",
      "composer.envMode",
      "composer.branch",
      "composer.interactionMode",
    ],
  },
  {
    id: "models",
    title: "Models",
    commands: [
      "modelPicker.toggle",
      "modelPicker.previousProvider",
      "modelPicker.nextProvider",
      "model.switchRecent",
    ],
  },
  {
    id: "panels",
    title: "Panels",
    commands: [
      "terminal.toggle",
      "terminal.split",
      "terminal.new",
      "terminal.close",
      "diff.toggle",
      "rightPanel.closeTab",
    ],
  },
];

const MODEL_PICKER_JUMP_COMMAND_SET = new Set<KeybindingCommand>(
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
);

/**
 * Commands that belong to a named section. Anything else in
 * `STATIC_KEYBINDING_COMMANDS` falls into "Other" so a newly added command
 * still shows up in the reference before it is filed.
 */
const SECTIONED_COMMANDS = new Set<KeybindingCommand>(
  SHORTCUT_SECTION_DEFINITIONS.flatMap((section) => section.commands),
);

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function entryMatchesQuery(entry: ShortcutEntry, query: string): boolean {
  if (query.length === 0) return true;
  return (
    entry.label.toLowerCase().includes(query) ||
    (entry.context?.toLowerCase().includes(query) ?? false) ||
    entry.command.toLowerCase().includes(query) ||
    entry.shortcut.toLowerCase().includes(query)
  );
}

/**
 * Build the shortcut reference from the resolved keybindings. Commands with
 * no active binding on this platform are left out; the model picker's
 * numbered jumps are summarised by the picker's own entry.
 */
export function buildShortcutSections(
  keybindings: ResolvedKeybindingsConfig,
  options: { readonly platform?: string; readonly query?: string } = {},
): ShortcutSection[] {
  const platform = options.platform ?? navigator.platform;
  const query = normalizeQuery(options.query ?? "");
  const toEntry = (command: StaticKeybindingCommand): ShortcutEntry | null => {
    const binding = shortcutBindingForCommand(keybindings, command);
    if (!binding) return null;
    return {
      command,
      label: formatKeybindingCommandLabel(command),
      shortcut: formatShortcutLabel(binding.shortcut, platform),
      context: shortcutContextLabel(binding.whenAst),
    };
  };
  const collect = (commands: ReadonlyArray<StaticKeybindingCommand>) =>
    commands
      .map(toEntry)
      .filter((entry): entry is ShortcutEntry => entry !== null)
      .filter((entry) => entryMatchesQuery(entry, query));

  const sections: ShortcutSection[] = SHORTCUT_SECTION_DEFINITIONS.map((section) => ({
    id: section.id,
    title: section.title,
    entries: collect(section.commands),
  }));
  const otherCommands = STATIC_KEYBINDING_COMMANDS.filter(
    (command) => !SECTIONED_COMMANDS.has(command) && !MODEL_PICKER_JUMP_COMMAND_SET.has(command),
  );
  sections.push({ id: "other", title: "Other", entries: collect(otherCommands) });
  return sections.filter((section) => section.entries.length > 0);
}
