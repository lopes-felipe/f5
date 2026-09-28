import type { AppSettings } from "~/appSettings";

export function composerRequiresSendModifier(
  shortcut: AppSettings["sendShortcut"],
  prompt: string,
): boolean {
  return shortcut === "mod-enter" || (shortcut === "mod-enter-multiline" && /[\r\n]/.test(prompt));
}

export function shouldSubmitComposer(input: {
  shortcut: AppSettings["sendShortcut"];
  prompt: string;
  shiftKey: boolean;
  altKey: boolean;
  modifierKey: boolean;
}): boolean {
  return (
    !input.shiftKey &&
    !input.altKey &&
    (!composerRequiresSendModifier(input.shortcut, input.prompt) || input.modifierKey)
  );
}
