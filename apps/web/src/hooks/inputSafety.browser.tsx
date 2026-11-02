import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../components/ui/menu";
import { notifyPreviewFocused } from "../lib/previewFocus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { getServerHttpOrigin } from "../lib/serverHttpOrigin";
import { writeTextToClipboard } from "./useCopyToClipboard";
import { useCommitOnBlur } from "./useCommitOnBlur";

function BufferedInput({ commit }: { commit: (value: string) => void }) {
  return <input aria-label="Setting" {...useCommitOnBlur("", commit)} />;
}

function BufferedTextarea(props: {
  value: string;
  commit: (value: string) => Promise<unknown>;
  onError: (error: unknown) => void;
}) {
  return (
    <textarea
      aria-label="Instructions"
      {...useCommitOnBlur(props.value, props.commit, {
        multiline: true,
        trim: true,
        onError: props.onError,
      })}
    />
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("input safety", () => {
  it.each([true, false])(
    "restores focus and selection after fallback copy (success=%s)",
    async (success) => {
      vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
        new Error("Unavailable over HTTP"),
      );
      const input = document.createElement("input");
      document.body.appendChild(input);
      input.value = "draft text";
      input.focus();
      input.setSelectionRange(2, 5);
      const copy = vi.spyOn(document, "execCommand").mockImplementation(() => {
        expect((document.activeElement as HTMLTextAreaElement).value).toBe("copied text");
        return success;
      });
      const count = document.querySelectorAll("textarea").length;
      try {
        if (success) await writeTextToClipboard("copied text");
        else
          await expect(writeTextToClipboard("copied text")).rejects.toThrow(
            "Clipboard copy failed",
          );
        expect(copy).toHaveBeenCalledWith("copy");
        expect(document.activeElement).toBe(input);
        expect(input.selectionStart).toBe(2);
        expect(input.selectionEnd).toBe(5);
        expect(document.querySelectorAll("textarea")).toHaveLength(count);
      } finally {
        input.remove();
      }
    },
  );

  it("does not blur a settings input when Enter confirms IME text", async () => {
    const commit = vi.fn();
    const screen = await render(<BufferedInput commit={commit} />);
    const input = screen.getByRole("textbox").element() as HTMLInputElement;
    await screen.getByRole("textbox").fill("日本語");
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );
    expect(document.activeElement).toBe(input);
    expect(commit).not.toHaveBeenCalled();
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true }),
    );
    expect(document.activeElement).toBe(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await expect.poll(() => commit.mock.calls).toEqual([["日本語"]]);
  });
});

describe("multiline commit on blur", () => {
  it("keeps typing through a save that lands mid-edit and commits trimmed text", async () => {
    const commit = vi.fn(async () => undefined);
    const onError = vi.fn();
    const screen = await render(<BufferedTextarea value="" commit={commit} onError={onError} />);
    const textarea = screen.getByRole("textbox").element() as HTMLTextAreaElement;
    await screen.getByRole("textbox").fill("first  ");
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(document.activeElement).toBe(textarea);
    textarea.blur();
    expect(commit).toHaveBeenCalledWith("first");

    await screen.getByRole("textbox").fill("second draft");
    await screen.rerender(<BufferedTextarea value="first" commit={commit} onError={onError} />);
    expect(textarea.value).toBe("second draft");
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a failed save and restores the saved value", async () => {
    const failure = new Error("Server unavailable");
    const commit = vi.fn(async () => {
      throw failure;
    });
    const onError = vi.fn();
    const screen = await render(
      <BufferedTextarea value="saved" commit={commit} onError={onError} />,
    );
    const textarea = screen.getByRole("textbox").element() as HTMLTextAreaElement;
    await screen.getByRole("textbox").fill("edited");
    textarea.blur();

    await expect.poll(() => onError.mock.calls).toEqual([[failure]]);
    await expect.poll(() => textarea.value).toBe("saved");
  });
});

it("preserves TLS for an uppercase configured WebSocket URL", () => {
  vi.stubEnv("VITE_WS_URL", "WSS://remote.example.com");
  expect(getServerHttpOrigin()).toBe("https://remote.example.com");
});

it("does not commit a focused settings draft during fallback copy and keeps the API error as cause", async () => {
  const original = new Error("Permission denied");
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(original);
  vi.spyOn(document, "execCommand").mockReturnValue(false);
  const commit = vi.fn();
  const screen = await render(<BufferedInput commit={commit} />);
  await screen.getByRole("textbox").fill("unsaved setting");
  await expect(writeTextToClipboard("copy")).rejects.toMatchObject({ cause: original });
  expect(commit).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(screen.getByRole("textbox").element());
  (document.activeElement as HTMLInputElement).blur();
  expect(commit).toHaveBeenCalledWith("unsaved setting");
});

it("closes host menus on preview focus without simulating a document pointer press", async () => {
  const press = vi.fn();
  document.addEventListener("pointerdown", press);
  const screen = await render(
    <Menu modal={false}>
      <MenuTrigger>Menu</MenuTrigger>
      <MenuPopup>
        <MenuItem>Action</MenuItem>
      </MenuPopup>
    </Menu>,
  );
  try {
    await screen.getByRole("button", { name: "Menu" }).click();
    await expect.element(screen.getByRole("menuitem", { name: "Action" })).toBeVisible();
    press.mockClear();
    notifyPreviewFocused();
    await expect.element(screen.getByRole("menuitem", { name: "Action" })).not.toBeInTheDocument();
    expect(press).not.toHaveBeenCalled();
  } finally {
    document.removeEventListener("pointerdown", press);
    await screen.unmount();
  }
});
