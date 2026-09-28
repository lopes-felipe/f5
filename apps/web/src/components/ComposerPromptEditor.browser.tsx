import "../index.css";
import { useRef, useState } from "react";
import { expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { PopupFocusContext } from "./ui/popupFocus";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "./ui/menu";
import { render } from "vitest-browser-react";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

function Harness({ initial = "**Bold** and `code` with @src/main.ts" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
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
        cursor={cursor}
        terminalContexts={[]}
        disabled={false}
        placeholder="Prompt"
        onChange={(next, position) => {
          setValue(next);
          setCursor(position);
        }}
        onRemoveTerminalContext={() => {}}
        onPaste={() => {}}
      />
      <button onClick={() => setRich((value) => !value)}>Toggle styling</button>
      <button onClick={() => setSnapshot(editor.current?.readSnapshot().value ?? "")}>
        Read prompt
      </button>
      <output aria-label="Serialized prompt">{snapshot}</output>
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
