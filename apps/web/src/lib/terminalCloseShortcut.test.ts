import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vitest";

import {
  createTerminalCloseRepeatGuard,
  type TerminalCloseShortcutEvent,
} from "./terminalCloseShortcut";

type KeyboardEventOverrides = Partial<
  Pick<TerminalCloseShortcutEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "repeat">
>;

function keyboardEvent(
  overrides: KeyboardEventOverrides = {},
): TerminalCloseShortcutEvent & { readonly defaultPrevented: boolean } {
  let defaultPrevented = false;
  return {
    key: "w",
    metaKey: false,
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    repeat: false,
    ...overrides,
    preventDefault: () => {
      defaultPrevented = true;
    },
    get defaultPrevented() {
      return defaultPrevented;
    },
  };
}

const LINUX = "Linux x86_64";
const TERMINAL_FOCUSED = { terminalFocus: true, terminalOpen: true, dialogFocus: false };

describe("createTerminalCloseRepeatGuard", () => {
  it("keeps a held close from reaching the next Ctrl+W owner once its terminal is gone", () => {
    const guard = createTerminalCloseRepeatGuard();
    const firstPress = keyboardEvent();
    expect(guard.preventRepeat(firstPress, DEFAULT_RESOLVED_KEYBINDINGS, LINUX)).toBe(false);
    guard.arm(TERMINAL_FOCUSED); // The close-terminal handler closed a terminal.

    let leakedRepeats = 0;
    for (let index = 0; index < 3; index += 1) {
      const event = keyboardEvent({ repeat: true });
      guard.preventRepeat(event, DEFAULT_RESOLVED_KEYBINDINGS, LINUX);
      if (!event.defaultPrevented) leakedRepeats += 1;
    }

    expect(leakedRepeats).toBe(0);
  });

  it("matches the macOS Cmd+W binding", () => {
    const guard = createTerminalCloseRepeatGuard();
    guard.arm(TERMINAL_FOCUSED);
    const event = keyboardEvent({ ctrlKey: false, metaKey: true, repeat: true });

    expect(guard.preventRepeat(event, DEFAULT_RESOLVED_KEYBINDINGS, "MacIntel")).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it("matches repeats in the context the close was resolved in", () => {
    // A custom binding that closes an open but unfocused terminal.
    const keybindings = DEFAULT_RESOLVED_KEYBINDINGS.map((binding) =>
      binding.command === "terminal.close"
        ? {
            ...binding,
            whenAst: {
              type: "and" as const,
              left: {
                type: "not" as const,
                node: { type: "identifier" as const, name: "terminalFocus" },
              },
              right: { type: "identifier" as const, name: "terminalOpen" },
            },
          }
        : binding,
    );
    const guard = createTerminalCloseRepeatGuard();
    guard.arm({ terminalFocus: false, terminalOpen: true, dialogFocus: false });
    const repeat = keyboardEvent({ repeat: true });

    expect(guard.preventRepeat(repeat, keybindings, LINUX)).toBe(true);
    expect(repeat.defaultPrevented).toBe(true);
  });

  it("leaves holds that never closed a terminal alone, such as closing right-panel tabs", () => {
    const guard = createTerminalCloseRepeatGuard();
    const repeat = keyboardEvent({ repeat: true });

    expect(guard.preventRepeat(repeat, DEFAULT_RESOLVED_KEYBINDINGS, LINUX)).toBe(false);
    expect(repeat.defaultPrevented).toBe(false);
  });

  it("disarms on release or a fresh press", () => {
    const guard = createTerminalCloseRepeatGuard();
    guard.arm(TERMINAL_FOCUSED);
    guard.release();
    expect(
      guard.preventRepeat(keyboardEvent({ repeat: true }), DEFAULT_RESOLVED_KEYBINDINGS, LINUX),
    ).toBe(false);

    guard.arm(TERMINAL_FOCUSED);
    guard.preventRepeat(keyboardEvent({ key: "a" }), DEFAULT_RESOLVED_KEYBINDINGS, LINUX);
    expect(
      guard.preventRepeat(keyboardEvent({ repeat: true }), DEFAULT_RESOLVED_KEYBINDINGS, LINUX),
    ).toBe(false);
  });

  it("leaves deliberate presses, unrelated repeats and rebound shortcuts alone", () => {
    const guard = createTerminalCloseRepeatGuard();
    guard.arm(TERMINAL_FOCUSED);
    for (const event of [
      keyboardEvent({ key: "q", repeat: true }),
      keyboardEvent({ shiftKey: true, repeat: true }),
    ]) {
      expect(guard.preventRepeat(event, DEFAULT_RESOLVED_KEYBINDINGS, LINUX)).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    }
    const rebound = DEFAULT_RESOLVED_KEYBINDINGS.filter(
      (binding) => binding.command !== "terminal.close",
    );
    expect(guard.preventRepeat(keyboardEvent({ repeat: true }), rebound, LINUX)).toBe(false);
  });
});
