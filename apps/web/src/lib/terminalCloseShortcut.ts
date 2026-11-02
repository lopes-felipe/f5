import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { isTerminalCloseShortcut, type ShortcutEventLike } from "../keybindings";

export interface TerminalCloseShortcutEvent extends ShortcutEventLike {
  readonly repeat?: boolean;
  readonly preventDefault: () => void;
}

/**
 * Swallows an auto-repeated close-terminal keydown. Holding the shortcut
 * outlives the terminal that handled the first press; once the last terminal
 * unmounts, a repeat would otherwise reach the next Cmd/Ctrl+W owner (a
 * right-panel tab, or the browser tab). Matched as if a terminal still had
 * focus, since by then none does. Deliberate presses are never touched.
 */
export function preventRepeatedTerminalCloseShortcut(
  event: TerminalCloseShortcutEvent,
  keybindings: ResolvedKeybindingsConfig,
  platform?: string,
): boolean {
  if (!event.repeat) return false;
  const matches = isTerminalCloseShortcut(event, keybindings, {
    ...(platform === undefined ? {} : { platform }),
    context: { terminalFocus: true, terminalOpen: true },
  });
  if (!matches) return false;
  event.preventDefault();
  return true;
}
