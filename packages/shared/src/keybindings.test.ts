import { describe, expect, it } from "vitest";

import {
  DEFAULT_KEYBINDINGS,
  DEFAULT_RESOLVED_KEYBINDINGS,
  evaluateWhenNode,
  matchesKeybindingTarget,
  parseKeybindingShortcut,
  parseWhenAst,
  encodeWhenAst,
} from "./keybindings";

describe("shared keybinding helpers", () => {
  it("matches equivalent shortcut aliases and canonical when expressions", () => {
    expect(
      matchesKeybindingTarget(
        { command: "commandPalette.toggle", key: "cmd+k", when: "a && b" },
        { command: "commandPalette.toggle", key: "meta+k", when: "(a && b)" },
      ),
    ).toBe(true);
  });

  it("does not match different when expressions", () => {
    expect(
      matchesKeybindingTarget(
        { command: "commandPalette.toggle", key: "mod+k", when: "a && b" },
        { command: "commandPalette.toggle", key: "mod+k", when: "a || b" },
      ),
    ).toBe(false);
  });

  it("round trips parsed when expressions", () => {
    const ast = parseWhenAst("terminalOpen && !terminalFocus");
    expect(ast).not.toBeNull();
    expect(ast ? encodeWhenAst(ast) : null).toBe("(terminalOpen && !(terminalFocus))");
  });

  it("parses plus key shortcuts", () => {
    expect(parseKeybindingShortcut("mod++")).toMatchObject({ key: "+", modKey: true });
  });

  it("scopes modified-enter defaults by dialog focus", () => {
    expect(DEFAULT_KEYBINDINGS).toContainEqual({
      key: "mod+enter",
      command: "chat.scrollToBottom",
      when: "!dialogFocus",
    });
    expect(DEFAULT_KEYBINDINGS).toContainEqual({
      key: "mod+enter",
      command: "dialog.primaryAction",
      when: "dialogFocus",
    });

    const scrollBinding = DEFAULT_RESOLVED_KEYBINDINGS.find(
      (binding) => binding.command === "chat.scrollToBottom",
    );
    const dialogBinding = DEFAULT_RESOLVED_KEYBINDINGS.find(
      (binding) => binding.command === "dialog.primaryAction",
    );

    expect(scrollBinding?.whenAst).toBeDefined();
    expect(dialogBinding?.whenAst).toBeDefined();
    expect(
      scrollBinding?.whenAst
        ? evaluateWhenNode(scrollBinding.whenAst, { dialogFocus: false })
        : null,
    ).toBe(true);
    expect(
      scrollBinding?.whenAst
        ? evaluateWhenNode(scrollBinding.whenAst, { dialogFocus: true })
        : null,
    ).toBe(false);
    expect(
      dialogBinding?.whenAst
        ? evaluateWhenNode(dialogBinding.whenAst, { dialogFocus: true })
        : null,
    ).toBe(true);
    expect(
      dialogBinding?.whenAst
        ? evaluateWhenNode(dialogBinding.whenAst, { dialogFocus: false })
        : null,
    ).toBe(false);
  });
});
