import {
  KeybindingRule as KeybindingRuleSchema,
  type KeybindingCommand,
  type KeybindingRule,
  type NativeApi,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { Schema } from "effect";

export const PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE = "Invalid keybinding.";

function normalizeProjectScriptKeybindingInput(
  keybinding: string | null | undefined,
): string | null {
  const trimmed = keybinding?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function decodeProjectScriptKeybindingRule(input: {
  keybinding: string | null | undefined;
  command: KeybindingCommand | null;
}): KeybindingRule | null {
  const normalizedKey = normalizeProjectScriptKeybindingInput(input.keybinding);
  if (!normalizedKey) return null;

  const decoded = Schema.decodeUnknownOption(KeybindingRuleSchema)({
    key: normalizedKey,
    command: input.command,
  });
  if (decoded._tag === "None") {
    throw new Error(PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE);
  }
  return decoded.value;
}

/**
 * Replaces a project action's custom shortcut on the server: removes every custom rule for its
 * command, then adds the new one. Desktop and browser clients both save it.
 */
export async function replaceProjectScriptKeybinding(input: {
  readonly server: Pick<NativeApi["server"], "addKeybinding" | "removeKeybinding">;
  readonly customKeybindings: ReadonlyArray<KeybindingRule>;
  readonly command: KeybindingCommand | null;
  readonly rule: KeybindingRule | null;
}): Promise<void> {
  for (const target of input.customKeybindings) {
    if (target.command === input.command) await input.server.removeKeybinding({ target });
  }
  if (input.rule) await input.server.addKeybinding({ rule: input.rule });
}

export function keybindingValueForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand | null,
): string | null {
  if (command === null) return null;
  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (!binding || binding.command !== command) continue;

    const parts: string[] = [];
    if (binding.shortcut.modKey) parts.push("mod");
    if (binding.shortcut.ctrlKey) parts.push("ctrl");
    if (binding.shortcut.metaKey) parts.push("meta");
    if (binding.shortcut.altKey) parts.push("alt");
    if (binding.shortcut.shiftKey) parts.push("shift");
    const keyToken =
      binding.shortcut.key === " "
        ? "space"
        : binding.shortcut.key === "escape"
          ? "esc"
          : binding.shortcut.key;
    parts.push(keyToken);
    return parts.join("+");
  }
  return null;
}
