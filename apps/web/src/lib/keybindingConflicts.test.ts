import { describe, expect, it } from "vitest";

import type { KeybindingWhenNode, ResolvedKeybindingsConfig } from "@t3tools/contracts";

import {
  findConflictsForCandidateKeybinding,
  findKeybindingConflicts,
  formatKeybindingCommandLabel,
  parseKeybindingShortcutValue,
} from "./keybindingConflicts";

function whenIdentifier(name: string): KeybindingWhenNode {
  return { type: "identifier", name };
}

function whenNot(node: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "not", node };
}

function whenAnd(left: KeybindingWhenNode, right: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "and", left, right };
}

function whenAllIdentifiers(prefix: string, count: number): KeybindingWhenNode {
  let node = whenIdentifier(`${prefix}-0`);
  for (let index = 1; index < count; index += 1) {
    node = whenAnd(node, whenIdentifier(`${prefix}-${index}`));
  }
  return node;
}

const modN = {
  key: "n",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  modKey: true,
} as const;

describe("parseKeybindingShortcutValue", () => {
  it("parses normalized shortcut tokens", () => {
    expect(parseKeybindingShortcutValue("mod+shift+n")).toEqual({
      key: "n",
      metaKey: false,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      modKey: true,
    });
  });
});

describe("findKeybindingConflicts", () => {
  it("reports overlapping shortcuts and keeps later bindings as winners", () => {
    const conflicts = findKeybindingConflicts([
      {
        command: "chat.new",
        shortcut: modN,
      },
      {
        command: "workflow.new",
        shortcut: modN,
      },
    ] satisfies ResolvedKeybindingsConfig);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.shadowed.command).toBe("chat.new");
    expect(conflicts[0]?.winner.command).toBe("workflow.new");
  });

  it("does not report mutually-exclusive terminal-focus bindings", () => {
    const conflicts = findKeybindingConflicts([
      {
        command: "terminal.new",
        shortcut: modN,
        whenAst: whenIdentifier("terminalFocus"),
      },
      {
        command: "chat.new",
        shortcut: modN,
        whenAst: whenNot(whenIdentifier("terminalFocus")),
      },
    ] satisfies ResolvedKeybindingsConfig);

    expect(conflicts).toEqual([]);
  });

  it("conservatively reports overlap once clauses exceed the identifier cutoff", () => {
    const conflicts = findKeybindingConflicts([
      {
        command: "chat.new",
        shortcut: modN,
        whenAst: whenAllIdentifiers("left", 11),
      },
      {
        command: "workflow.new",
        shortcut: modN,
        whenAst: whenNot(whenAllIdentifiers("left", 11)),
      },
    ] satisfies ResolvedKeybindingsConfig);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.winner.command).toBe("workflow.new");
  });
});

describe("findConflictsForCandidateKeybinding", () => {
  it("flags overlaps against both global and terminal-only bindings", () => {
    const conflicts = findConflictsForCandidateKeybinding(
      [
        {
          command: "terminal.new",
          shortcut: modN,
          whenAst: whenIdentifier("terminalFocus"),
        },
        {
          command: "chat.new",
          shortcut: modN,
          whenAst: whenNot(whenIdentifier("terminalFocus")),
        },
      ] satisfies ResolvedKeybindingsConfig,
      {
        command: "script.build.run",
        shortcut: modN,
      },
    );

    expect(conflicts.map((binding) => binding.command)).toEqual(["terminal.new", "chat.new"]);
  });

  it("ignores the command currently being edited", () => {
    const conflicts = findConflictsForCandidateKeybinding(
      [
        {
          command: "script.build.run",
          shortcut: modN,
        },
      ] satisfies ResolvedKeybindingsConfig,
      {
        command: "script.build.run",
        shortcut: modN,
      },
    );

    expect(conflicts).toEqual([]);
  });
});

describe("formatKeybindingCommandLabel", () => {
  it("formats static and project action commands", () => {
    expect(formatKeybindingCommandLabel("chat.new")).toBe("New thread");
    expect(
      formatKeybindingCommandLabel("script.build.run", [
        {
          id: "build",
          name: "Build",
          command: "bun run build",
          icon: "build",
          runOnWorktreeCreate: false,
        },
      ]),
    ).toBe("Action: Build");
    expect(formatKeybindingCommandLabel("script.missing.run")).toBe("Action: missing (unbound)");
  });
});
