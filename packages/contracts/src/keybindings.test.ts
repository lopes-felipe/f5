import { Schema } from "effect";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  ForwardCompatibleKeybindingsConfig,
  KeybindingsConfig,
  KeybindingRule,
  MAX_KEYBINDINGS_COUNT,
  ResolvedKeybindingRule,
  ResolvedKeybindingsConfig,
} from "./keybindings";

const decode = <S extends Schema.Top>(
  schema: S,
  input: unknown,
): Effect.Effect<Schema.Schema.Type<S>, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(schema as never)(input) as Effect.Effect<
    Schema.Schema.Type<S>,
    Schema.SchemaError,
    never
  >;

const decodeResolvedRule = Schema.decodeUnknownEffect(ResolvedKeybindingRule as never);
const encodeResolvedKeybindings = Schema.encodeEffect(ResolvedKeybindingsConfig);

it.effect("parses keybinding rules", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(KeybindingRule, {
      key: "mod+j",
      command: "terminal.toggle",
    });
    assert.strictEqual(parsed.command, "terminal.toggle");

    const parsedClose = yield* decode(KeybindingRule, {
      key: "mod+w",
      command: "terminal.close",
    });
    assert.strictEqual(parsedClose.command, "terminal.close");

    const parsedSidebarToggle = yield* decode(KeybindingRule, {
      key: "mod+b",
      command: "sidebar.toggle",
    });
    assert.strictEqual(parsedSidebarToggle.command, "sidebar.toggle");

    const parsedUsageOpen = yield* decode(KeybindingRule, {
      key: "mod+u",
      command: "usage.open",
    });
    assert.strictEqual(parsedUsageOpen.command, "usage.open");

    const parsedDiffToggle = yield* decode(KeybindingRule, {
      key: "mod+d",
      command: "diff.toggle",
    });
    assert.strictEqual(parsedDiffToggle.command, "diff.toggle");

    const parsedLocal = yield* decode(KeybindingRule, {
      key: "mod+shift+n",
      command: "chat.newLocal",
    });
    assert.strictEqual(parsedLocal.command, "chat.newLocal");

    const parsedWorkflowNew = yield* decode(KeybindingRule, {
      key: "mod+shift+n",
      command: "workflow.new",
    });
    assert.strictEqual(parsedWorkflowNew.command, "workflow.new");

    const parsedScrollToBottom = yield* decode(KeybindingRule, {
      key: "mod+enter",
      command: "chat.scrollToBottom",
    });
    assert.strictEqual(parsedScrollToBottom.command, "chat.scrollToBottom");

    const parsedDialogPrimaryAction = yield* decode(KeybindingRule, {
      key: "mod+enter",
      command: "dialog.primaryAction",
    });
    assert.strictEqual(parsedDialogPrimaryAction.command, "dialog.primaryAction");

    const parsedThreadSwitchNext = yield* decode(KeybindingRule, {
      key: "ctrl+tab",
      command: "thread.switchRecentNext",
    });
    assert.strictEqual(parsedThreadSwitchNext.command, "thread.switchRecentNext");

    const parsedThreadSwitchPrevious = yield* decode(KeybindingRule, {
      key: "ctrl+shift+tab",
      command: "thread.switchRecentPrevious",
    });
    assert.strictEqual(parsedThreadSwitchPrevious.command, "thread.switchRecentPrevious");

    const parsedModelPickerToggle = yield* decode(KeybindingRule, {
      key: "mod+shift+m",
      command: "modelPicker.toggle",
    });
    assert.strictEqual(parsedModelPickerToggle.command, "modelPicker.toggle");

    const parsedPrHubOpen = yield* decode(KeybindingRule, {
      key: "mod+shift+p",
      command: "prHub.open",
    });
    assert.strictEqual(parsedPrHubOpen.command, "prHub.open");

    const parsedModelPickerJump = yield* decode(KeybindingRule, {
      key: "mod+1",
      command: "modelPicker.jump.1",
    });
    assert.strictEqual(parsedModelPickerJump.command, "modelPicker.jump.1");
  }),
);

it.effect("rejects invalid command values", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decode(KeybindingRule, {
        key: "mod+j",
        command: "script.Test.run",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("accepts dynamic script run commands", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(KeybindingRule, {
      key: "mod+r",
      command: "script.setup.run",
    });
    assert.strictEqual(parsed.command, "script.setup.run");
  }),
);

it.effect("parses keybindings array payload", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(KeybindingsConfig, [
      { key: "mod+j", command: "terminal.toggle" },
      { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
    ]);
    assert.lengthOf(parsed, 2);
  }),
);

it.effect("parses resolved keybinding rules", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingRule, {
      command: "terminal.split",
      shortcut: {
        key: "d",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      },
      whenAst: {
        type: "and",
        left: { type: "identifier", name: "terminalOpen" },
        right: {
          type: "not",
          node: { type: "identifier", name: "terminalFocus" },
        },
      },
    });
    assert.strictEqual(parsed.shortcut.key, "d");
  }),
);

it.effect("parses resolved keybindings arrays", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingsConfig, [
      {
        command: "terminal.toggle",
        shortcut: {
          key: "j",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      },
    ]);
    assert.lengthOf(parsed, 1);
  }),
);

const shortcut = {
  key: "p",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  modKey: true,
};

it.effect("drops resolved rules with commands this build does not know", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingsConfig, [
      { command: "terminal.toggle", shortcut },
      { command: "someFuture.toggle", shortcut },
      { command: "sidebar.toggle", shortcut },
    ]);
    assert.deepEqual(
      parsed.map((rule) => rule.command),
      ["terminal.toggle", "sidebar.toggle"],
    );
  }),
);

it.effect("drops resolved rules with unknown when-node types", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingsConfig, [
      {
        command: "terminal.toggle",
        shortcut,
        whenAst: { type: "xor", left: 1, right: 2 },
      },
      { command: "terminal.split", shortcut },
    ]);
    assert.deepEqual(
      parsed.map((rule) => rule.command),
      ["terminal.split"],
    );
  }),
);

it.effect("drops malformed resolved rule entries", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingsConfig, [
      "garbage",
      { command: "terminal.toggle", shortcut },
      null,
    ]);
    assert.deepEqual(
      parsed.map((rule) => rule.command),
      ["terminal.toggle"],
    );
  }),
);

it.effect("still enforces the resolved keybindings count limit", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decode(
        ResolvedKeybindingsConfig,
        Array.from({ length: MAX_KEYBINDINGS_COUNT + 1 }, () => ({
          command: "terminal.toggle",
          shortcut,
        })),
      ),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("counts dropped entries against the resolved keybindings limit", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decode(ResolvedKeybindingsConfig, [
        { command: "terminal.toggle", shortcut },
        ...Array.from({ length: MAX_KEYBINDINGS_COUNT }, () => ({
          command: "someFuture.toggle",
          shortcut,
        })),
      ]),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("drops customized rules with commands this build does not know", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ForwardCompatibleKeybindingsConfig, [
      { key: "mod+p", command: "someFuture.toggle" },
      { key: "mod+j", command: "terminal.toggle" },
    ]);
    assert.deepEqual(parsed, [{ key: "mod+j", command: "terminal.toggle" }]);
  }),
);

it.effect("encodes resolved keybindings to the plain wire shape", () =>
  Effect.gen(function* () {
    const rules = [{ command: "terminal.toggle" as const, shortcut }];
    const encoded = yield* encodeResolvedKeybindings(rules);
    assert.deepEqual(encoded, rules);
    const roundTripped = yield* decode(ResolvedKeybindingsConfig, encoded);
    assert.deepEqual(roundTripped, rules);
  }),
);

it.effect("drops unknown fields in resolved keybinding rules", () =>
  decodeResolvedRule({
    command: "terminal.toggle",
    shortcut: {
      key: "j",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    },
    key: "mod+j",
  }).pipe(
    Effect.map((parsed) => {
      const view = parsed as Record<string, unknown>;
      assert.strictEqual("key" in view, false);
      assert.strictEqual(view.command, "terminal.toggle");
    }),
  ),
);
