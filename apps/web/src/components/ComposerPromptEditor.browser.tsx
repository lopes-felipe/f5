import "../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { serverQueryKeys } from "../lib/serverReactQuery";
import { expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { PopupFocusContext } from "./ui/popupFocus";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "./ui/menu";
import { render } from "vitest-browser-react";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { createComposerMention, type ComposerMention } from "../composer-editor-mentions";

function Harness({
  initial = "**Bold** and `code` with @src/main.ts",
  initialMentions = [],
  workspaceCwd,
}: {
  initial?: string;
  initialMentions?: readonly ComposerMention[];
  workspaceCwd?: string;
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
        workspaceCwd={workspaceCwd}
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
      <button
        onClick={() =>
          editor.current?.insertAssistantQuote({
            threadId: "source",
            messageId: "response",
            text: "Quoted",
            comment: "Explain",
          })
        }
      >
        Insert commented quote
      </button>
    </>
  );
}
it("uses the composer workspace to drag a relative file mention", async () => {
  const startFileDrag = vi.fn(async () => true);
  const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.stubGlobal("desktopBridge", { startFileDrag });
  try {
    const view = await render(
      <Harness
        initial="@src/main.ts"
        initialMentions={[createComposerMention("src/main.ts", 0)]}
        workspaceCwd="/checkout"
      />,
    );
    const chip = view
      .getByTestId("composer-editor")
      .element()
      .querySelector<HTMLElement>("[data-composer-mention-chip]");
    expect(chip?.draggable).toBe(true);
    chip?.dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
    expect(startFileDrag).toHaveBeenCalledWith("/checkout/src/main.ts");
    await view.unmount();
  } finally {
    vi.unstubAllGlobals();
    platform.mockRestore();
  }
});

it("keeps a retained quote comment outside the atomic token while editing", async () => {
  const screen = await render(<Harness initial="" />);
  try {
    await screen.getByRole("button", { name: "Insert commented quote" }).click();
    await screen.getByRole("button", { name: "Focus end" }).click();
    await userEvent.keyboard("More");
    await screen.getByRole("button", { name: "Read prompt" }).click();
    const text = screen.getByLabelText("Serialized prompt").element().textContent!;
    expect(text).toContain("f5-context://");
    expect(text).toContain("Explain");
    expect(text.trimEnd()).toMatch(/Explain\s*More$/);
    await screen.getByRole("button", { name: "Toggle styling" }).click();
    await screen.getByRole("button", { name: "Read prompt" }).click();
    expect(screen.getByLabelText("Serialized prompt").element().textContent).toBe(text);
  } finally {
    await screen.unmount();
  }
});
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

it("continues and exits numbered lists with Shift+Enter and preserves undo", async () => {
  const screen = await render(<Harness initial="1. First" />);
  try {
    await screen.getByRole("button", { name: "Focus end" }).click();
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    await screen.getByRole("button", { name: "Read prompt" }).click();
    expect(screen.getByLabelText("Serialized prompt").element().textContent).toBe("1. First\n2. ");
    await screen.getByRole("button", { name: "Focus end" }).click();
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    await screen.getByRole("button", { name: "Read prompt" }).click();
    expect(screen.getByLabelText("Serialized prompt").element().textContent).toBe("1. First\n");
    await screen.getByRole("button", { name: "Focus end" }).click();
    const modifier = navigator.platform.toUpperCase().includes("MAC") ? "Meta" : "Control";
    await userEvent.keyboard("{" + modifier + ">}z{/" + modifier + "}");
    await screen.getByRole("button", { name: "Read prompt" }).click();
    expect(screen.getByLabelText("Serialized prompt").element().textContent).toBe("1. First\n2. ");
  } finally {
    await screen.unmount();
  }
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

it("renders mention chip icons locally while the server runs with DO_NOT_TRACK", async () => {
  const mention = createComposerMention("src/main.ts", 0);
  const client = new QueryClient();
  client.setQueryData(serverQueryKeys.config(), { privacy: { doNotTrack: true } });
  const screen = await render(
    <QueryClientProvider client={client}>
      <Harness initial="@src/main.ts" initialMentions={[mention]} />
    </QueryClientProvider>,
  );
  const chip = screen
    .getByTestId("composer-editor")
    .element()
    .querySelector("[data-composer-mention-chip]");
  expect(chip).not.toBeNull();
  expect(chip?.querySelector("img")).toBeNull();
  expect(chip?.querySelector("svg")).not.toBeNull();
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
  const option = screen.getByRole("menuitem", { name: "Option", exact: true });
  await expect.element(option).toBeVisible();
  // Popup visibility precedes its asynchronous initial focus. Send Escape only
  // after opening has finished, so that close and open focus effects cannot race.
  await expect
    .poll(() => screen.getByRole("menu").element().contains(document.activeElement))
    .toBe(true);
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

it("keeps a PR reference chip and its complete URL through styling, deletion and undo", async () => {
  const raw = "[PR #7](https://github.com/org/repo/pull/7)";
  const screen = await render(<Harness initial={raw} />);
  const editor = screen.getByTestId("composer-editor");
  await expect
    .poll(() => editor.element().querySelector("[data-composer-pr-reference]")?.textContent)
    .toBe("org/repo#7");
  await screen.getByRole("button", { name: "Toggle styling" }).click();
  await screen.getByRole("button", { name: "Read prompt" }).click();
  await expect.element(screen.getByLabelText("Serialized prompt")).toHaveTextContent(raw);
  await expect.element(screen.getByLabelText("Mentions")).toHaveTextContent("[]");
  await screen.getByRole("button", { name: "Focus end" }).click();
  await userEvent.keyboard("{Backspace}");
  await expect
    .poll(() => editor.element().querySelector("[data-composer-pr-reference]"))
    .toBeNull();
  const modifier = navigator.platform.toUpperCase().includes("MAC") ? "Meta" : "Control";
  await userEvent.keyboard("{" + modifier + ">}z{/" + modifier + "}");
  await expect
    .poll(() => editor.element().querySelector("[data-composer-pr-reference]")?.textContent)
    .toBe("org/repo#7");
  await screen.getByRole("button", { name: "Read prompt" }).click();
  await expect.element(screen.getByLabelText("Serialized prompt")).toHaveTextContent(raw);
});
