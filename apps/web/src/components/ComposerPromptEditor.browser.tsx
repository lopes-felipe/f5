import "../index.css";
import { useRef, useState } from "react";
import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { PopupFocusContext } from "./ui/popupFocus";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "./ui/menu";
import { render } from "vitest-browser-react";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { createComposerMention, type ComposerMention } from "../composer-editor-mentions";

function Harness({
  initial = "**Bold** and `code` with @src/main.ts",
  initialMentions = [],
}: {
  initial?: string;
  initialMentions?: readonly ComposerMention[];
}) {
  const [value, setValue] = useState(initial);
  const [mentions, setMentions] = useState(initialMentions);
  const [cursor, setCursor] = useState(0);
  const [rich, setRich] = useState(true);
  const [snapshot, setSnapshot] = useState("");
  const editor = useRef<ComposerPromptEditorHandle>(null);
  return (
    <>
      <ComposerPromptEditor
        ref={editor}
        richTextEnabled={rich}
        value={value}
        mentions={mentions}
        cursor={cursor}
        terminalContexts={[]}
        disabled={false}
        placeholder="Prompt"
        onChange={(next, position, _expanded, _adjacent, _contexts, nextMentions) => {
          setValue(next);
          setCursor(position);
          setMentions(nextMentions);
        }}
        onRemoveTerminalContext={() => {}}
        onPaste={() => {}}
      />
      <button onClick={() => setRich((value) => !value)}>Toggle styling</button>
      <button onClick={() => setSnapshot(editor.current?.readSnapshot().value ?? "")}>
        Read prompt
      </button>
      <output aria-label="Serialized prompt">{snapshot}</output>
      <output aria-label="Mentions">{JSON.stringify(mentions)}</output>
      <button onClick={() => editor.current?.focusAtEnd()}>Focus end</button>
    </>
  );
}
it("changes Markdown styling without rewriting prompt bytes or file mentions", async () => {
  const screen = await render(<Harness />);
  const editor = screen.getByTestId("composer-editor");
  await expect
    .poll(() => editor.element().querySelector('[style*="font-weight"]')?.textContent)
    .toBe("**Bold**");
  await screen.getByRole("button", { name: "Read prompt" }).click();
  await expect
    .element(screen.getByLabelText("Serialized prompt"))
    .toHaveTextContent("**Bold** and `code` with @src/main.ts");
  await screen.getByRole("button", { name: "Toggle styling" }).click();
  await expect.poll(() => editor.element().querySelector('[style*="font-weight"]')).toBeNull();
  await screen.getByRole("button", { name: "Read prompt" }).click();
  await expect
    .element(screen.getByLabelText("Serialized prompt"))
    .toHaveTextContent("**Bold** and `code` with @src/main.ts");
});

it("keeps pasted and typed handles literal, including quoted paths", async () => {
  const screen = await render(<Harness initial="" />);
  const editor = screen.getByTestId("composer-editor");
  await editor.click();
  await userEvent.type(editor, "Use @creditornot/wolt-auth please ");
  const transfer = new DataTransfer();
  transfer.setData("text/plain", '@"src/main.ts" @scope/package ');
  editor.element().dispatchEvent(
    new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }),
  );
  await expect.element(screen.getByLabelText("Mentions")).toHaveTextContent("[]");
  expect(editor.element().querySelectorAll("[data-composer-mention-chip]")).toHaveLength(0);
  await screen.getByRole("button", { name: "Read prompt" }).click();
  await expect
    .element(screen.getByLabelText("Serialized prompt"))
    .toHaveTextContent('Use @creditornot/wolt-auth please @"src/main.ts" @scope/package');
});

it("preserves only the selected occurrence through deletion and undo/redo", async () => {
  const prompt = "@src/main.ts @src/main.ts";
  const mention = createComposerMention("src/main.ts", 13);
  const screen = await render(<Harness initial={prompt} initialMentions={[mention]} />);
  const editor = screen.getByTestId("composer-editor");
  expect(editor.element().querySelectorAll("[data-composer-mention-chip]")).toHaveLength(1);
  await screen.getByRole("button", { name: "Focus end" }).click();
  await userEvent.keyboard("{Backspace}");
  await expect.element(screen.getByLabelText("Mentions")).toHaveTextContent("[]");
  const modifier = navigator.platform.toUpperCase().includes("MAC") ? "Meta" : "Control";
  await userEvent.keyboard("{" + modifier + ">}z{/" + modifier + "}");
  await expect
    .poll(() => editor.element().querySelectorAll("[data-composer-mention-chip]").length)
    .toBe(1);
  await expect.element(screen.getByLabelText("Mentions")).toHaveTextContent(mention.id);
  await userEvent.keyboard("{" + modifier + ">}{Shift>}z{/Shift}{/" + modifier + "}");
  await expect.element(screen.getByLabelText("Mentions")).toHaveTextContent("[]");
});

it("preserves explicitly quoted mention source when toggling editor mode", async () => {
  const prompt = 'Read @"src/main.ts" and @"My File.md"';
  const screen = await render(<Harness initial={prompt} />);
  await screen.getByRole("button", { name: "Toggle styling" }).click();
  await screen.getByRole("button", { name: "Read prompt" }).click();
  await expect.element(screen.getByLabelText("Serialized prompt")).toHaveTextContent(prompt);
});

it("returns focus from a composer option menu on Escape", async () => {
  let input: HTMLInputElement | null = null;
  const screen = await render(
    <PopupFocusContext
      value={() => {
        input?.focus();
        return false;
      }}
    >
      <input
        aria-label="Draft"
        ref={(element) => {
          input = element;
        }}
      />
      <Menu>
        <MenuTrigger>Options</MenuTrigger>
        <MenuPopup>
          <MenuItem>Option</MenuItem>
        </MenuPopup>
      </Menu>
    </PopupFocusContext>,
  );
  await screen.getByRole("button", { name: "Options" }).click();
  await expect.element(screen.getByRole("menuitem", { name: "Option", exact: true })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(screen.getByRole("textbox", { name: "Draft" })).toHaveFocus();
});

it.each(["**a****b**", "# Title **bold**", "**a**__b__", "`a``b`"])(
  "loads adjacent Markdown styles without a transform loop: %s",
  async (prompt) => {
    const screen = await render(<Harness initial={prompt} />);
    await screen.getByRole("button", { name: "Read prompt" }).click();
    await expect.element(screen.getByLabelText("Serialized prompt")).toHaveTextContent(prompt);
    await screen.getByRole("button", { name: "Toggle styling" }).click();
    await screen.getByRole("button", { name: "Toggle styling" }).click();
    await screen.getByRole("button", { name: "Read prompt" }).click();
    await expect.element(screen.getByLabelText("Serialized prompt")).toHaveTextContent(prompt);
  },
);
