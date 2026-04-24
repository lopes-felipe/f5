import { assert, describe, it } from "vitest";

import {
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  formatShortcutLabel,
  isChatNewShortcut,
  isChatNewLocalShortcut,
  isDiffToggleShortcut,
  isOpenFavoriteEditorShortcut,
  isThreadSwitchRecentNextShortcut,
  isThreadSwitchRecentPreviousShortcut,
  isTerminalClearShortcut,
  isTerminalCloseShortcut,
  isTerminalNewShortcut,
  isTerminalSplitShortcut,
  isTerminalToggleShortcut,
  resolveShortcutBinding,
  resolveShortcutCommand,
  shortcutLabelForCommand,
  terminalDeleteShortcutData,
  terminalNavigationShortcutData,
  type ShortcutEventLike,
} from "./keybindings";

function event(overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return {
    key: "j",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

function modShortcut(
  key: string,
  overrides: Partial<Omit<KeybindingShortcut, "key">> = {},
): KeybindingShortcut {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: true,
    ...overrides,
  };
}

function whenIdentifier(name: string): KeybindingWhenNode {
  return { type: "identifier", name };
}

function whenNot(node: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "not", node };
}

function whenAnd(left: KeybindingWhenNode, right: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "and", left, right };
}

interface TestBinding {
  shortcut: KeybindingShortcut;
  command: KeybindingCommand;
  whenAst?: KeybindingWhenNode;
}

function compile(bindings: TestBinding[]): ResolvedKeybindingsConfig {
  return bindings.map((binding) => ({
    command: binding.command,
    shortcut: binding.shortcut,
    ...(binding.whenAst ? { whenAst: binding.whenAst } : {}),
  }));
}

const DEFAULT_BINDINGS = compile([
  { shortcut: modShortcut("j"), command: "terminal.toggle" },
  {
    shortcut: modShortcut("d"),
    command: "terminal.split",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("n"),
    command: "terminal.new",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("w"),
    command: "terminal.close",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("d"),
    command: "diff.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("n"),
    command: "chat.new",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("n", { shiftKey: true }),
    command: "workflow.new",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  { shortcut: modShortcut("enter"), command: "chat.scrollToBottom" },
  { shortcut: modShortcut("o"), command: "editor.openFavorite" },
  {
    shortcut: { ...modShortcut("tab"), modKey: false, ctrlKey: true },
    command: "thread.switchRecentNext",
  },
  {
    shortcut: { ...modShortcut("tab"), modKey: false, ctrlKey: true, shiftKey: true },
    command: "thread.switchRecentPrevious",
  },
]);

describe("isTerminalToggleShortcut", () => {
  it("matches Cmd+J on macOS", () => {
    assert.isTrue(
      isTerminalToggleShortcut(event({ metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
  });

  it("matches Ctrl+J on non-macOS", () => {
    assert.isTrue(
      isTerminalToggleShortcut(event({ ctrlKey: true }), DEFAULT_BINDINGS, { platform: "Win32" }),
    );
  });
});

describe("split/new/close terminal shortcuts", () => {
  it("requires terminalFocus for default split/new/close bindings", () => {
    assert.isFalse(
      isTerminalSplitShortcut(event({ key: "d", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
    assert.isFalse(
      isTerminalNewShortcut(event({ key: "n", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
    );
    assert.isFalse(
      isTerminalCloseShortcut(event({ key: "w", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
    );
  });

  it("matches split/new when terminalFocus is true", () => {
    assert.isTrue(
      isTerminalSplitShortcut(event({ key: "d", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
    assert.isTrue(
      isTerminalNewShortcut(event({ key: "n", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
    assert.isTrue(
      isTerminalCloseShortcut(event({ key: "w", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
  });

  it("supports when expressions", () => {
    const keybindings = compile([
      {
        shortcut: modShortcut("\\"),
        command: "terminal.split",
        whenAst: whenAnd(whenIdentifier("terminalOpen"), whenNot(whenIdentifier("terminalFocus"))),
      },
      {
        shortcut: modShortcut("n", { shiftKey: true }),
        command: "terminal.new",
        whenAst: whenAnd(whenIdentifier("terminalOpen"), whenNot(whenIdentifier("terminalFocus"))),
      },
      { shortcut: modShortcut("j"), command: "terminal.toggle" },
    ]);
    assert.isTrue(
      isTerminalSplitShortcut(event({ key: "\\", ctrlKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: true, terminalFocus: false },
      }),
    );
    assert.isFalse(
      isTerminalSplitShortcut(event({ key: "\\", ctrlKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: false, terminalFocus: false },
      }),
    );
    assert.isTrue(
      isTerminalNewShortcut(event({ key: "n", ctrlKey: true, shiftKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: true, terminalFocus: false },
      }),
    );
  });

  it("supports when boolean literals", () => {
    const keybindings = compile([
      { shortcut: modShortcut("n"), command: "terminal.new", whenAst: whenIdentifier("true") },
      { shortcut: modShortcut("m"), command: "terminal.new", whenAst: whenIdentifier("false") },
    ]);

    assert.isTrue(
      isTerminalNewShortcut(event({ key: "n", ctrlKey: true }), keybindings, {
        platform: "Linux",
      }),
    );
    assert.isFalse(
      isTerminalNewShortcut(event({ key: "m", ctrlKey: true }), keybindings, {
        platform: "Linux",
      }),
    );
  });
});

describe("shortcutLabelForCommand", () => {
  it("returns the most recent binding label", () => {
    const bindings = compile([
      {
        shortcut: modShortcut("\\"),
        command: "terminal.split",
        whenAst: whenIdentifier("terminalFocus"),
      },
      {
        shortcut: modShortcut("\\", { shiftKey: true }),
        command: "terminal.split",
        whenAst: whenNot(whenIdentifier("terminalFocus")),
      },
    ]);
    assert.strictEqual(
      shortcutLabelForCommand(bindings, "terminal.split", "Linux"),
      "Ctrl+Shift+\\",
    );
  });

  it("returns labels for non-terminal commands", () => {
    assert.strictEqual(shortcutLabelForCommand(DEFAULT_BINDINGS, "chat.new", "MacIntel"), "⌘N");
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "workflow.new", "MacIntel"),
      "⇧⌘N",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "chat.scrollToBottom", "Linux"),
      "Ctrl+Enter",
    );
    assert.strictEqual(shortcutLabelForCommand(DEFAULT_BINDINGS, "diff.toggle", "Linux"), "Ctrl+D");
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "editor.openFavorite", "Linux"),
      "Ctrl+O",
    );
  });
});

describe("chat/editor shortcuts", () => {
  it("matches chat.new shortcut", () => {
    assert.isTrue(
      isChatNewShortcut(event({ key: "n", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
    assert.isTrue(
      isChatNewShortcut(event({ key: "n", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
    );
  });

  it("matches recent thread switching shortcuts", () => {
    assert.isTrue(
      isThreadSwitchRecentNextShortcut(event({ key: "Tab", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
      }),
    );
    assert.isTrue(
      isThreadSwitchRecentPreviousShortcut(
        event({ key: "Tab", ctrlKey: true, shiftKey: true }),
        DEFAULT_BINDINGS,
        { platform: "Linux" },
      ),
    );
  });

  it("matches chat.newLocal shortcut", () => {
    const keybindings = compile([
      { shortcut: modShortcut("l", { shiftKey: true }), command: "chat.newLocal" },
    ]);

    assert.isTrue(
      isChatNewLocalShortcut(event({ key: "l", metaKey: true, shiftKey: true }), keybindings, {
        platform: "MacIntel",
      }),
    );
    assert.isTrue(
      isChatNewLocalShortcut(event({ key: "l", ctrlKey: true, shiftKey: true }), keybindings, {
        platform: "Linux",
      }),
    );
  });

  it("matches editor.openFavorite shortcut", () => {
    assert.isTrue(
      isOpenFavoriteEditorShortcut(event({ key: "o", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
    assert.isTrue(
      isOpenFavoriteEditorShortcut(event({ key: "o", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
      }),
    );
  });

  it("matches diff.toggle shortcut outside terminal focus", () => {
    assert.isTrue(
      isDiffToggleShortcut(event({ key: "d", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
    assert.isFalse(
      isDiffToggleShortcut(event({ key: "d", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
  });
});

describe("cross-command precedence", () => {
  it("uses when + order so a later focused rule overrides a global rule", () => {
    const keybindings = compile([
      { shortcut: modShortcut("n"), command: "chat.new" },
      {
        shortcut: modShortcut("n"),
        command: "terminal.new",
        whenAst: whenIdentifier("terminalFocus"),
      },
    ]);

    assert.isTrue(
      isTerminalNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
    assert.isFalse(
      isChatNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
    assert.isFalse(
      isTerminalNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
    assert.isTrue(
      isChatNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
  });

  it("still lets a later global rule win when both rules match", () => {
    const keybindings = compile([
      {
        shortcut: modShortcut("n"),
        command: "terminal.new",
        whenAst: whenIdentifier("terminalFocus"),
      },
      { shortcut: modShortcut("n"), command: "chat.new" },
    ]);

    assert.isFalse(
      isTerminalNewShortcut(event({ key: "n", ctrlKey: true }), keybindings, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
    assert.isTrue(
      isChatNewShortcut(event({ key: "n", ctrlKey: true }), keybindings, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
  });
});

describe("resolveShortcutCommand", () => {
  it("returns dynamic script commands", () => {
    const keybindings = compile([{ shortcut: modShortcut("r"), command: "script.setup.run" }]);

    assert.strictEqual(
      resolveShortcutCommand(event({ key: "r", ctrlKey: true }), keybindings, {
        platform: "Linux",
      }),
      "script.setup.run",
    );
  });

  it("returns recent thread switching commands", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "Tab", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
      }),
      "thread.switchRecentNext",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "Tab", ctrlKey: true, shiftKey: true }),
        DEFAULT_BINDINGS,
        {
          platform: "Linux",
        },
      ),
      "thread.switchRecentPrevious",
    );
  });

  it("returns workflow and scroll-to-bottom commands", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "n", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "workflow.new",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "Enter", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
      }),
      "chat.scrollToBottom",
    );
  });

  it("lets the last matching recent-thread rule win", () => {
    const keybindings = compile([
      {
        shortcut: { ...modShortcut("tab"), modKey: false, ctrlKey: true },
        command: "thread.switchRecentNext",
      },
      {
        shortcut: { ...modShortcut("tab"), modKey: false, ctrlKey: true },
        command: "chat.new",
      },
    ]);

    assert.strictEqual(
      resolveShortcutCommand(event({ key: "Tab", ctrlKey: true }), keybindings, {
        platform: "Linux",
      }),
      "chat.new",
    );
  });

  it("returns the matched binding for recent-thread commands", () => {
    const binding = resolveShortcutBinding(
      event({ key: "Tab", ctrlKey: true, shiftKey: true }),
      DEFAULT_BINDINGS,
      { platform: "Linux" },
    );

    assert.deepEqual(binding, {
      command: "thread.switchRecentPrevious",
      shortcut: {
        key: "tab",
        metaKey: false,
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        modKey: false,
      },
    });
  });

  it("respects when clauses for recent-thread commands", () => {
    const keybindings = compile([
      {
        shortcut: { ...modShortcut("tab"), modKey: false, ctrlKey: true },
        command: "thread.switchRecentNext",
        whenAst: whenIdentifier("terminalFocus"),
      },
    ]);

    assert.isTrue(
      isThreadSwitchRecentNextShortcut(event({ key: "Tab", ctrlKey: true }), keybindings, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
    assert.isFalse(
      isThreadSwitchRecentNextShortcut(event({ key: "Tab", ctrlKey: true }), keybindings, {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
    );
  });
});

describe("formatShortcutLabel", () => {
  it("formats labels for macOS", () => {
    assert.strictEqual(
      formatShortcutLabel(modShortcut("d", { shiftKey: true }), "MacIntel"),
      "⇧⌘D",
    );
  });

  it("formats labels for non-macOS", () => {
    assert.strictEqual(
      formatShortcutLabel(modShortcut("d", { shiftKey: true }), "Linux"),
      "Ctrl+Shift+D",
    );
  });

  it("formats labels for plus key", () => {
    assert.strictEqual(formatShortcutLabel(modShortcut("+"), "MacIntel"), "⌘+");
    assert.strictEqual(formatShortcutLabel(modShortcut("+"), "Linux"), "Ctrl++");
  });
});

describe("isTerminalClearShortcut", () => {
  it("matches Ctrl+L on all platforms", () => {
    assert.isTrue(isTerminalClearShortcut(event({ key: "l", ctrlKey: true }), "Linux"));
    assert.isTrue(isTerminalClearShortcut(event({ key: "l", ctrlKey: true }), "MacIntel"));
  });

  it("matches Cmd+K on macOS", () => {
    assert.isTrue(isTerminalClearShortcut(event({ key: "k", metaKey: true }), "MacIntel"));
  });

  it("ignores non-keydown events", () => {
    assert.isFalse(
      isTerminalClearShortcut(event({ type: "keyup", key: "l", ctrlKey: true }), "Linux"),
    );
  });
});

describe("terminalDeleteShortcutData", () => {
  it("maps Cmd+Backspace on macOS to delete-to-line-start", () => {
    assert.strictEqual(
      terminalDeleteShortcutData(event({ key: "Backspace", metaKey: true }), "MacIntel"),
      "\u0015",
    );
  });

  it("ignores non-macOS platforms and modified variants", () => {
    assert.isNull(terminalDeleteShortcutData(event({ key: "Backspace", metaKey: true }), "Linux"));
    assert.isNull(terminalDeleteShortcutData(event({ key: "Backspace", metaKey: true }), "Win32"));
    assert.isNull(
      terminalDeleteShortcutData(
        event({ key: "Backspace", metaKey: true, altKey: true }),
        "MacIntel",
      ),
    );
  });

  it("ignores non-keydown events", () => {
    assert.isNull(
      terminalDeleteShortcutData(
        event({ type: "keyup", key: "Backspace", metaKey: true }),
        "MacIntel",
      ),
    );
  });
});

describe("terminalNavigationShortcutData", () => {
  it("maps Option+Arrow on macOS to word movement", () => {
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowLeft", altKey: true }), "MacIntel"),
      "\u001bb",
    );
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowRight", altKey: true }), "MacIntel"),
      "\u001bf",
    );
  });

  it("maps Cmd+Arrow on macOS to line movement", () => {
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowLeft", metaKey: true }), "MacIntel"),
      "\u0001",
    );
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowRight", metaKey: true }), "MacIntel"),
      "\u0005",
    );
  });

  it("maps Ctrl+Arrow on non-macOS to word movement", () => {
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowLeft", ctrlKey: true }), "Win32"),
      "\u001bb",
    );
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowRight", ctrlKey: true }), "Linux"),
      "\u001bf",
    );
  });

  it("rejects unsupported combinations", () => {
    assert.isNull(
      terminalNavigationShortcutData(
        event({ key: "ArrowLeft", shiftKey: true, altKey: true }),
        "MacIntel",
      ),
    );
    assert.isNull(
      terminalNavigationShortcutData(event({ key: "ArrowLeft", metaKey: true }), "Linux"),
    );
    assert.isNull(terminalNavigationShortcutData(event({ key: "a", altKey: true }), "MacIntel"));
  });

  it("ignores non-keydown events", () => {
    assert.isNull(
      terminalNavigationShortcutData(
        event({ type: "keyup", key: "ArrowLeft", altKey: true }),
        "MacIntel",
      ),
    );
  });
});

describe("plus key parsing", () => {
  it("matches the plus key shortcut", () => {
    const plusBindings = compile([{ shortcut: modShortcut("+"), command: "terminal.toggle" }]);
    assert.isTrue(
      isTerminalToggleShortcut(event({ key: "+", metaKey: true }), plusBindings, {
        platform: "MacIntel",
      }),
    );
    assert.isTrue(
      isTerminalToggleShortcut(event({ key: "+", ctrlKey: true }), plusBindings, {
        platform: "Linux",
      }),
    );
  });
});
