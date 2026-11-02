import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vitest";

import {
  preventRepeatedTerminalCloseShortcut,
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

describe("preventRepeatedTerminalCloseShortcut", () => {
  it("keeps held close repeats from reaching the next Ctrl+W owner once terminals are gone", () => {
    let leakedRepeats = 0;
    for (let index = 0; index < 3; index += 1) {
      const event = keyboardEvent({ repeat: true });
      preventRepeatedTerminalCloseShortcut(event, DEFAULT_RESOLVED_KEYBINDINGS, "Linux x86_64");
      if (!event.defaultPrevented) leakedRepeats += 1;
    }

    expect(leakedRepeats).toBe(0);
  });

  it("matches the macOS Cmd+W binding", () => {
    const event = keyboardEvent({ ctrlKey: false, metaKey: true, repeat: true });

    expect(
      preventRepeatedTerminalCloseShortcut(event, DEFAULT_RESOLVED_KEYBINDINGS, "MacIntel"),
    ).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves a deliberate press and unrelated repeats alone", () => {
    const deliberate = keyboardEvent({ repeat: false });
    const unrelated = keyboardEvent({ key: "q", repeat: true });
    const shifted = keyboardEvent({ shiftKey: true, repeat: true });

    for (const event of [deliberate, unrelated, shifted]) {
      expect(
        preventRepeatedTerminalCloseShortcut(event, DEFAULT_RESOLVED_KEYBINDINGS, "Linux x86_64"),
      ).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it("follows a rebound close-terminal shortcut", () => {
    const keybindings = DEFAULT_RESOLVED_KEYBINDINGS.filter(
      (binding) => binding.command !== "terminal.close",
    );

    expect(
      preventRepeatedTerminalCloseShortcut(
        keyboardEvent({ repeat: true }),
        keybindings,
        "Linux x86_64",
      ),
    ).toBe(false);
  });
});
