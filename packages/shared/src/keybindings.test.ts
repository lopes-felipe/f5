import { describe, expect, it } from "vitest";

import {
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
});
