import type {
  KeybindingCommand,
  KeybindingShortcut,
  KeybindingWhenNode,
  ProjectScript,
  ResolvedKeybindingRule,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { STATIC_KEYBINDING_COMMANDS } from "@t3tools/contracts";
import {
  evaluateWhenNode,
  parseKeybindingShortcut,
  shortcutSignature,
} from "@t3tools/shared/keybindings";

import { projectScriptIdFromCommand } from "../projectScripts";

// Conflict checks brute-force every truth assignment across the identifiers used by
// both `when` clauses. Cap the enumeration to keep UI validation responsive even if
// the DSL grows; once we cross this ceiling we conservatively assume overlap, which
// can over-report conflicts for very complex clauses.
const MAX_CONFLICT_IDENTIFIER_ENUMERATION = 10;

type StaticKeybindingCommand = (typeof STATIC_KEYBINDING_COMMANDS)[number];
const STATIC_KEYBINDING_COMMAND_SET = new Set<string>(STATIC_KEYBINDING_COMMANDS);

export interface KeybindingConflict {
  readonly shortcut: KeybindingShortcut;
  readonly shadowed: ResolvedKeybindingRule;
  readonly winner: ResolvedKeybindingRule;
}

export function parseKeybindingShortcutValue(value: string): KeybindingShortcut | null {
  return parseKeybindingShortcut(value);
}

function collectIdentifiers(
  node: KeybindingWhenNode | undefined,
  identifiers: Set<string>,
): Set<string> {
  if (!node) {
    return identifiers;
  }

  switch (node.type) {
    case "identifier":
      if (node.name !== "true" && node.name !== "false") {
        identifiers.add(node.name);
      }
      return identifiers;
    case "not":
      return collectIdentifiers(node.node, identifiers);
    case "and":
    case "or":
      collectIdentifiers(node.left, identifiers);
      collectIdentifiers(node.right, identifiers);
      return identifiers;
  }
}

function doWhenClausesOverlap(
  left: KeybindingWhenNode | undefined,
  right: KeybindingWhenNode | undefined,
): boolean {
  const identifiers = [...collectIdentifiers(left, collectIdentifiers(right, new Set<string>()))];

  if (identifiers.length === 0) {
    return evaluateWhenNode(left, {}) && evaluateWhenNode(right, {});
  }
  if (identifiers.length > MAX_CONFLICT_IDENTIFIER_ENUMERATION) {
    return true;
  }

  const assignments = 1 << identifiers.length;
  for (let mask = 0; mask < assignments; mask += 1) {
    const context: Record<string, boolean> = {};
    for (const [index, identifier] of identifiers.entries()) {
      context[identifier] = (mask & (1 << index)) !== 0;
    }
    if (evaluateWhenNode(left, context) && evaluateWhenNode(right, context)) {
      return true;
    }
  }

  return false;
}

export function findKeybindingConflicts(
  keybindings: ResolvedKeybindingsConfig,
): ReadonlyArray<KeybindingConflict> {
  const conflicts: KeybindingConflict[] = [];

  for (let shadowedIndex = 0; shadowedIndex < keybindings.length; shadowedIndex += 1) {
    const shadowed = keybindings[shadowedIndex];
    if (!shadowed) continue;

    for (let winnerIndex = shadowedIndex + 1; winnerIndex < keybindings.length; winnerIndex += 1) {
      const winner = keybindings[winnerIndex];
      if (!winner || winner.command === shadowed.command) continue;
      if (shortcutSignature(winner.shortcut) !== shortcutSignature(shadowed.shortcut)) continue;
      if (!doWhenClausesOverlap(winner.whenAst, shadowed.whenAst)) continue;
      conflicts.push({
        shortcut: winner.shortcut,
        shadowed,
        winner,
      });
    }
  }

  return conflicts;
}

export function findConflictsForCandidateKeybinding(
  keybindings: ResolvedKeybindingsConfig,
  candidate: {
    readonly command: KeybindingCommand;
    readonly shortcut: KeybindingShortcut;
    readonly whenAst?: KeybindingWhenNode | undefined;
  },
  options?: {
    readonly ignoreCommands?: Iterable<KeybindingCommand>;
  },
): ReadonlyArray<ResolvedKeybindingRule> {
  const ignoredCommands = new Set(options?.ignoreCommands ?? []);
  const conflicts: ResolvedKeybindingRule[] = [];
  const candidateSignature = shortcutSignature(candidate.shortcut);

  for (const binding of keybindings) {
    if (!binding) continue;
    if (binding.command === candidate.command || ignoredCommands.has(binding.command)) continue;
    if (shortcutSignature(binding.shortcut) !== candidateSignature) continue;
    if (!doWhenClausesOverlap(binding.whenAst, candidate.whenAst)) continue;
    conflicts.push(binding);
  }

  return conflicts;
}

export function formatKeybindingCommandLabel(
  command: KeybindingCommand,
  scripts: ReadonlyArray<ProjectScript> = [],
): string {
  const scriptId = projectScriptIdFromCommand(command);
  if (scriptId) {
    const matchingScripts = scripts.filter((script) => script.id === scriptId);
    const distinctNames = [
      ...new Set(matchingScripts.map((script) => script.name.trim()).filter(Boolean)),
    ];

    if (distinctNames.length === 1) {
      return `Action: ${distinctNames[0]}`;
    }

    return `Action: ${scriptId} (unbound)`;
  }

  if (!STATIC_KEYBINDING_COMMAND_SET.has(command)) {
    return command;
  }

  const staticCommand = command as StaticKeybindingCommand;
  switch (staticCommand) {
    case "terminal.toggle":
      return "Toggle terminal";
    case "terminal.split":
      return "Split terminal";
    case "terminal.new":
      return "New terminal";
    case "terminal.close":
      return "Close terminal";
    case "diff.toggle":
      return "Toggle diff panel";
    case "chat.new":
      return "New thread";
    case "chat.newLocal":
      return "Reuse project draft";
    case "workflow.new":
      return "New workflow";
    case "chat.scrollToBottom":
      return "Scroll to bottom";
    case "dialog.primaryAction":
      return "Dialog primary action";
    case "editor.openFavorite":
      return "Open in preferred editor";
    case "thread.switchRecentNext":
      return "Next recent thread";
    case "thread.switchRecentPrevious":
      return "Previous recent thread";
    case "model.switchRecent":
      return "Switch recent model";
    case "modelPicker.toggle":
      return "Toggle model picker";
    case "modelPicker.jump.1":
      return "Pick model 1";
    case "modelPicker.jump.2":
      return "Pick model 2";
    case "modelPicker.jump.3":
      return "Pick model 3";
    case "modelPicker.jump.4":
      return "Pick model 4";
    case "modelPicker.jump.5":
      return "Pick model 5";
    case "modelPicker.jump.6":
      return "Pick model 6";
    case "modelPicker.jump.7":
      return "Pick model 7";
    case "modelPicker.jump.8":
      return "Pick model 8";
    case "modelPicker.jump.9":
      return "Pick model 9";
    case "commandPalette.toggle":
      return "Toggle command palette";
    default: {
      const _exhaustive: never = staticCommand;
      return _exhaustive;
    }
  }
}
