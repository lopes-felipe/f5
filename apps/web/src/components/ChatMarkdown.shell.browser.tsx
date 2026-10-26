import "../index.css";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import ChatMarkdown from "./ChatMarkdown";
import { TerminalCommandProvider } from "../terminalCommandContext";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("executable shell fences", () => {
  it("renders Mermaid only after streaming settles", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const text = "```mermaid\nflowchart LR\n First --> Second\n```";
    const view = await render(<ChatMarkdown text={text} cwd={undefined} isStreaming />, {
      container: host,
    });
    expect(host.querySelector("img")).toBeNull();
    await view.rerender(<ChatMarkdown text={text} cwd={undefined} />);
    await expect.element(view.getByRole("img", { name: "Mermaid diagram" })).toBeVisible();
    await view.getByRole("button", { name: "Show code" }).click();
    expect(host.querySelector("pre")?.textContent).toContain("First --> Second");
  });
  it("runs only on an explicit click, blocks duplicate submissions, and retries failures", async () => {
    let finish!: () => void;
    const execute = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const view = await render(
      <TerminalCommandProvider value={execute}>
        <ChatMarkdown text={"```bash\necho one\necho two\n```"} cwd={undefined} />
      </TerminalCommandProvider>,
    );
    const button = view.getByRole("button", { name: "Run in terminal" });
    await expect.element(button).toBeVisible();
    const header = button.element().parentElement!;
    const copy = header.querySelector<HTMLElement>('button[aria-label="Copy code"]');
    expect(copy).not.toBeNull();
    const pre = header.parentElement!.querySelector("pre")!;
    expect(copy!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      pre.getBoundingClientRect().top,
    );
    expect(execute).not.toHaveBeenCalled();
    await button.click();
    await expect.element(button).toBeDisabled();
    expect(execute).toHaveBeenCalledExactlyOnceWith("echo one\necho two");
    finish();
    await expect.element(button).toBeEnabled();
    execute.mockRejectedValueOnce(new Error("Terminal failed"));
    await button.click();
    await expect.element(view.getByText("Could not run command. Try again.")).toBeVisible();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each([
    { text: "```bash\necho hi\n```", isStreaming: true },
    { text: "```bash\necho hi", isStreaming: false },
    { text: "```bash\necho \u202Ehidden\n```", isStreaming: false },
    { text: "```js\nconsole.log('hi')\n```", isStreaming: false },
    { text: "```bash\necho hi\n```", isStreaming: false, policy: "external-bot" as const },
  ])("does not expose execution for unsafe or unfinished input ($text)", async (props) => {
    const execute = vi.fn(async () => {});
    const host = document.body.appendChild(document.createElement("div"));
    await render(
      <TerminalCommandProvider value={execute}>
        <ChatMarkdown {...props} cwd={undefined} />
      </TerminalCommandProvider>,
      { container: host },
    );
    expect(
      [...host.querySelectorAll("button")].some(
        (button) => button.textContent === "Run in terminal",
      ),
    ).toBe(false);
    expect(host.querySelector(".chat-markdown-codeblock-runnable")).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });
});
