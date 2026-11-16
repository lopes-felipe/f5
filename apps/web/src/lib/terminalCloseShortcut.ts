import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import {
  isTerminalCloseShortcut,
  type ShortcutEventLike,
  type ShortcutMatchContext,
} from "../keybindings";

export interface TerminalCloseShortcutEvent extends ShortcutEventLike {
  readonly repeat?: boolean;
  readonly preventDefault: () => void;
}

export interface TerminalCloseRepeatGuard {
  /**
   * Call when the close-terminal shortcut closed a terminal, with the context
   * it was resolved in. Repeats are matched in that same context, since the
   * live one (focus, open terminals) changes once the terminal is gone.
   */
  readonly arm: (context: Partial<ShortcutMatchContext>) => void;
  /** Call on keyup: the hold that closed the terminal is over. */
  readonly release: () => void;
  /**
   * Call first on every keydown. Swallows an auto-repeat of the shortcut that
   * closed a terminal and returns true; anything else returns false.
   */
  readonly preventRepeat: (
    event: TerminalCloseShortcutEvent,
    keybindings: ResolvedKeybindingsConfig,
    platform?: string,
  ) => boolean;
}

/**
 * Holding the close-terminal shortcut outlives the terminal that handled the
 * first press. Once the last terminal unmounts, its repeats would reach the
 * next Cmd/Ctrl+W owner: a right-panel tab, or the browser tab. Only a hold
 * that closed a terminal is guarded, so holding the same chord to close
 * right-panel tabs keeps working.
 */
export function createTerminalCloseRepeatGuard(): TerminalCloseRepeatGuard {
  let armedContext: Partial<ShortcutMatchContext> | null = null;
  return {
    arm: (context) => {
      armedContext = { ...context };
    },
    release: () => {
      armedContext = null;
    },
    preventRepeat: (event, keybindings, platform) => {
      if (!event.repeat) {
        // A fresh press starts a new hold; the terminal handler re-arms it.
        armedContext = null;
        return false;
      }
      if (armedContext === null) return false;
      const matches = isTerminalCloseShortcut(event, keybindings, {
        ...(platform === undefined ? {} : { platform }),
        context: armedContext,
      });
      if (!matches) return false;
      event.preventDefault();
      return true;
    },
  };
}
