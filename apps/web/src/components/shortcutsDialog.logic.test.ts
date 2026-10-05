import { STATIC_KEYBINDING_COMMANDS } from "@t3tools/contracts";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  compileResolvedKeybindingsConfig,
} from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vitest";

import { buildShortcutSections } from "./shortcutsDialog.logic";

describe("buildShortcutSections", () => {
  it("groups the default bindings into named sections", () => {
    const sections = buildShortcutSections(DEFAULT_RESOLVED_KEYBINDINGS, { platform: "MacIntel" });
    const general = sections.find((section) => section.id === "general");
    expect(general?.title).toBe("General");
    expect(general?.entries).toContainEqual({
      command: "commandPalette.toggle",
      label: "Toggle command palette",
      shortcut: "⌘K",
      context: null,
    });
    expect(general?.entries).toContainEqual({
      command: "help.shortcuts",
      label: "Show keyboard shortcuts",
      shortcut: "⌘/",
      context: null,
    });
  });

  it("names the context of shortcuts that share a key", () => {
    const entries = buildShortcutSections(DEFAULT_RESOLVED_KEYBINDINGS, {
      platform: "MacIntel",
    }).flatMap((section) => section.entries);
    const byCommand = new Map(entries.map((entry) => [entry.command, entry]));
    expect(byCommand.get("chat.new")).toMatchObject({ shortcut: "⌘N", context: null });
    expect(byCommand.get("terminal.new")).toMatchObject({
      shortcut: "⌘N",
      context: "In terminal",
    });
    expect(byCommand.get("dialog.primaryAction")?.context).toBe("In dialogs");
    expect(byCommand.get("chat.pageUp")?.shortcut).toBe("PgUp");
    expect(
      buildShortcutSections(DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        query: "in terminal",
      }).flatMap((section) => section.entries.map((entry) => entry.command)),
    ).toContain("terminal.close");
  });

  it("lists each command at most once and leaves out the numbered model jumps", () => {
    const commands = buildShortcutSections(DEFAULT_RESOLVED_KEYBINDINGS, {
      platform: "MacIntel",
    }).flatMap((section) => section.entries.map((entry) => entry.command));
    expect(new Set(commands).size).toBe(commands.length);
    expect(commands.some((command) => command.startsWith("modelPicker.jump."))).toBe(false);
    for (const command of commands) {
      expect(STATIC_KEYBINDING_COMMANDS).toContain(command);
    }
  });

  it("omits commands without a binding and drops empty sections", () => {
    const sections = buildShortcutSections(
      compileResolvedKeybindingsConfig([{ key: "mod+j", command: "terminal.toggle" }]),
      { platform: "Linux" },
    );
    expect(sections).toEqual([
      {
        id: "panels",
        title: "Panels",
        entries: [
          {
            command: "terminal.toggle",
            label: "Toggle terminal",
            shortcut: "Ctrl+J",
            context: null,
          },
        ],
      },
    ]);
  });

  it("reflects user overrides and filters by label, command id or keys", () => {
    const keybindings = compileResolvedKeybindingsConfig([
      { key: "mod+k", command: "commandPalette.toggle" },
      { key: "mod+shift+k", command: "commandPalette.toggle" },
      { key: "mod+b", command: "sidebar.toggle" },
    ]);
    const byLabel = buildShortcutSections(keybindings, { platform: "Linux", query: " palette " });
    expect(byLabel.flatMap((section) => section.entries)).toEqual([
      {
        command: "commandPalette.toggle",
        label: "Toggle command palette",
        shortcut: "Ctrl+Shift+K",
        context: null,
      },
    ]);
    const byCommand = buildShortcutSections(keybindings, {
      platform: "Linux",
      query: "sidebar.toggle",
    });
    expect(byCommand.flatMap((section) => section.entries.map((entry) => entry.command))).toEqual([
      "sidebar.toggle",
    ]);
    expect(buildShortcutSections(keybindings, { platform: "Linux", query: "nothing" })).toEqual([]);
  });
});
