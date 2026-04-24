import type {
  KeybindingCommand,
  KeybindingShortcut,
  KeybindingWhenNode,
  ProjectScript,
  ResolvedKeybindingRule,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";

import { projectScriptIdFromCommand } from "../projectScripts";

// Conflict checks brute-force every truth assignment across the identifiers used by
// both `when` clauses. Cap the enumeration to keep UI validation responsive even if
// the DSL grows; once we cross this ceiling we conservatively assume overlap, which
// can over-report conflicts for very complex clauses.
const MAX_CONFLICT_IDENTIFIER_ENUMERATION = 10;

const STATIC_COMMAND_LABELS: Partial<Record<KeybindingCommand, string>> = {
  "terminal.toggle": "Toggle terminal",
  "terminal.split": "Split terminal",
  "terminal.new": "New terminal",
  "terminal.close": "Close terminal",
  "diff.toggle": "Toggle diff panel",
  "chat.new": "New thread",
  "chat.newLocal": "Reuse project draft",
  "workflow.new": "New workflow",
  "chat.scrollToBottom": "Scroll to bottom",
  "editor.openFavorite": "Open in preferred editor",
  "thread.switchRecentNext": "Next recent thread",
  "thread.switchRecentPrevious": "Previous recent thread",
  "model.switchRecent": "Switch recent model",
  "commandPalette.toggle": "Toggle command palette",
};

export interface KeybindingConflict {
  readonly shortcut: KeybindingShortcut;
  readonly shadowed: ResolvedKeybindingRule;
  readonly winner: ResolvedKeybindingRule;
}

function normalizeKeyToken(token: string): string {
  if (token === "space") return " ";
  if (token === "esc") return "escape";
  return token;
}

export function parseKeybindingShortcutValue(value: string): KeybindingShortcut | null {
  const rawTokens = value
    .toLowerCase()
    .split("+")
    .map((token) => token.trim());
  const tokens = [...rawTokens];
  let trailingEmptyCount = 0;

  while (tokens[tokens.length - 1] === "") {
    trailingEmptyCount += 1;
    tokens.pop();
  }

  if (trailingEmptyCount > 0) {
    tokens.push("+");
  }
  if (tokens.length === 0 || tokens.some((token) => token.length === 0)) {
    return null;
  }

  let key: string | null = null;
  let metaKey = false;
  let ctrlKey = false;
  let shiftKey = false;
  let altKey = false;
  let modKey = false;

  for (const token of tokens) {
    switch (token) {
      case "cmd":
      case "meta":
        metaKey = true;
        break;
      case "ctrl":
      case "control":
        ctrlKey = true;
        break;
      case "shift":
        shiftKey = true;
        break;
      case "alt":
      case "option":
        altKey = true;
        break;
      case "mod":
        modKey = true;
        break;
      default:
        if (key !== null) return null;
        key = normalizeKeyToken(token);
    }
  }

  if (key === null) {
    return null;
  }

  return {
    key,
    metaKey,
    ctrlKey,
    shiftKey,
    altKey,
    modKey,
  };
}

function shortcutSignature(shortcut: KeybindingShortcut): string {
  return [
    shortcut.modKey ? "1" : "0",
    shortcut.metaKey ? "1" : "0",
    shortcut.ctrlKey ? "1" : "0",
    shortcut.altKey ? "1" : "0",
    shortcut.shiftKey ? "1" : "0",
    shortcut.key,
  ].join(":");
}

function evaluateWhenNode(
  node: KeybindingWhenNode | undefined,
  context: Record<string, boolean>,
): boolean {
  if (!node) {
    return true;
  }

  switch (node.type) {
    case "identifier":
      if (node.name === "true") return true;
      if (node.name === "false") return false;
      return Boolean(context[node.name]);
    case "not":
      return !evaluateWhenNode(node.node, context);
    case "and":
      return evaluateWhenNode(node.left, context) && evaluateWhenNode(node.right, context);
    case "or":
      return evaluateWhenNode(node.left, context) || evaluateWhenNode(node.right, context);
  }
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
  const staticLabel = STATIC_COMMAND_LABELS[command];
  if (staticLabel) {
    return staticLabel;
  }

  const scriptId = projectScriptIdFromCommand(command);
  if (!scriptId) {
    return command;
  }

  const matchingScripts = scripts.filter((script) => script.id === scriptId);
  const distinctNames = [
    ...new Set(matchingScripts.map((script) => script.name.trim()).filter(Boolean)),
  ];

  if (distinctNames.length === 1) {
    return `Action: ${distinctNames[0]}`;
  }

  return `Action: ${scriptId} (unbound)`;
}
