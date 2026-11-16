import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import type { KeybindingCommand } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { groupKeybindingRows } from "./KeybindingEditor.logic";

describe("groupKeybindingRows", () => {
  it("groups every default binding by area in page order", () => {
    const groups = groupKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS);
    expect(groups.map((group) => group.title)).toEqual([
      "Navigation",
      "Threads",
      "Composer",
      "Terminal",
      "Diff",
      "Usage",
      "Other",
    ]);
    expect(groups.find((group) => group.id === "composer")?.rows.map((row) => row.command)).toEqual(
      expect.arrayContaining(["composer.effort", "modelPicker.toggle", "model.switchRecent"]),
    );
    expect(groups.flatMap((group) => group.rows)).toHaveLength(DEFAULT_RESOLVED_KEYBINDINGS.length);
  });

  it("keeps row order inside a group and drops empty groups", () => {
    const rows = (["script.test.run", "terminal.new", "script.build.run"] as const).map(
      (command) => ({ command: command as KeybindingCommand }),
    );
    expect(
      groupKeybindingRows(rows).map((group) => [group.title, group.rows.map((row) => row.command)]),
    ).toEqual([
      ["Terminal", ["terminal.new"]],
      ["Project scripts", ["script.test.run", "script.build.run"]],
    ]);
  });
});
