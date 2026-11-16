import { MAX_KEYBINDING_VALUE_LENGTH, type KeybindingCommand } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import { commandForProjectScript } from "../projectScripts";
import {
  decodeProjectScriptKeybindingRule,
  keybindingValueForCommand,
  PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE,
  replaceProjectScriptKeybinding,
} from "./projectScriptKeybindings";

describe("projectScriptKeybindings", () => {
  it("replaces only the action's own shortcut, then saves the new one", async () => {
    const command = commandForProjectScript("test")!;
    const other = commandForProjectScript("lint")!;
    const calls: string[] = [];
    const server = {
      removeKeybinding: vi.fn(async ({ target }: { target: { key: string } }) => {
        calls.push(`remove ${target.key}`);
        return { keybindings: [], issues: [] };
      }),
      addKeybinding: vi.fn(async ({ rule }: { rule: { key: string } }) => {
        calls.push(`add ${rule.key}`);
        return { keybindings: [], issues: [] };
      }),
    };
    await replaceProjectScriptKeybinding({
      server: server as never,
      customKeybindings: [
        { key: "mod+shift+t", command },
        { key: "mod+shift+l", command: other },
      ],
      command,
      rule: decodeProjectScriptKeybindingRule({ keybinding: "mod+shift+y", command }),
    });
    expect(calls).toEqual(["remove mod+shift+t", "add mod+shift+y"]);
  });

  it("decodes and trims valid keybinding rules", () => {
    const rule = decodeProjectScriptKeybindingRule({
      keybinding: "  mod+k  ",
      command: commandForProjectScript("lint"),
    });

    expect(rule).toEqual({
      key: "mod+k",
      command: "script.lint.run",
    });
  });

  it("returns null when keybinding is empty", () => {
    expect(
      decodeProjectScriptKeybindingRule({
        keybinding: "   ",
        command: commandForProjectScript("lint"),
      }),
    ).toBeNull();
  });

  it("rejects invalid keybinding values", () => {
    expect(() =>
      decodeProjectScriptKeybindingRule({
        keybinding: "k".repeat(MAX_KEYBINDING_VALUE_LENGTH + 1),
        command: commandForProjectScript("lint"),
      }),
    ).toThrowError(PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE);
  });

  it("rejects invalid commands", () => {
    expect(() =>
      decodeProjectScriptKeybindingRule({
        keybinding: "mod+k",
        command: "script.BAD.run" as KeybindingCommand,
      }),
    ).toThrowError(PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE);
  });

  it("reads latest matching keybinding value for a command", () => {
    const command = commandForProjectScript("test")!;
    const value = keybindingValueForCommand(
      [
        {
          command,
          shortcut: {
            key: "escape",
            metaKey: false,
            ctrlKey: false,
            shiftKey: false,
            altKey: false,
            modKey: true,
          },
        },
        {
          command,
          shortcut: {
            key: "k",
            metaKey: false,
            ctrlKey: false,
            shiftKey: true,
            altKey: false,
            modKey: true,
          },
        },
      ],
      command,
    );

    expect(value).toBe("mod+shift+k");
  });
});
