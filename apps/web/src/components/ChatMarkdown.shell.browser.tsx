import "../index.css";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import ChatMarkdown from "./ChatMarkdown";
import { TerminalCommandProvider } from "../terminalCommandContext";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("executable shell fences", () => {
  it("renders a completed Mermaid fence while the response is still streaming", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const open = "```mermaid\nflowchart LR\n First --> Second";
    // The stream can end exactly on the closing fence.
    const closed = `${open}\n\`\`\``;
    const view = await render(<ChatMarkdown text={open} cwd={undefined} isStreaming />, {
      container: host,
    });
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("First --> Second");
    await view.rerender(<ChatMarkdown text={closed} cwd={undefined} isStreaming />);
    await expect.element(view.getByRole("img", { name: "Mermaid diagram" })).toBeVisible();
    const final = `${closed}\n\nThe remaining explanation.`;
    await view.rerender(<ChatMarkdown text={final} cwd={undefined} isStreaming />);
    expect(host.querySelector('img[alt="Mermaid diagram"]')).not.toBeNull();
    expect(host.textContent).toContain("The remaining explanation.");
    // Settling remounts the message; the cached diagram shows without a loading state.
    await view.rerender(<ChatMarkdown text={final} cwd={undefined} />);
    expect(host.querySelector('img[alt="Mermaid diagram"]')).not.toBeNull();
    expect(host.textContent).not.toContain("Rendering diagram");
    await view.getByRole("button", { name: "Show code" }).click();
    expect(host.querySelector("pre")?.textContent).toContain("First --> Second");
  });

  it("keeps a streamed diagram's view while later prose extends its list", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const list = "- Diagram\n\n  ```mermaid\n  flowchart LR\n  Third --> Fourth\n  ```\n";
    const view = await render(<ChatMarkdown text={list} cwd={undefined} isStreaming />, {
      container: host,
    });
    await expect.element(view.getByRole("img", { name: "Mermaid diagram" })).toBeVisible();
    await view.getByRole("button", { name: "Show code" }).click();
    await view.rerender(
      <ChatMarkdown text={`${list}  More about the diagram`} cwd={undefined} isStreaming />,
    );
    expect(host.textContent).toContain("More about the diagram");
    await expect.element(view.getByRole("button", { name: "Show diagram" })).toBeVisible();
    expect(host.querySelector("pre")?.textContent).toContain("Third --> Fourth");
  });

  it.each([
    [
      "an overindented list marker",
      "- Diagram\n\n  ```mermaid\n  flowchart LR\n  A --> B\n      ```\n",
    ],
    ["a shorter closing marker", "````mermaid\nflowchart LR\nA --> B\n```\n\nMore"],
  ])("keeps a Mermaid fence with %s as source while streaming", async (_, text) => {
    const host = document.body.appendChild(document.createElement("div"));
    await render(<ChatMarkdown text={text} cwd={undefined} isStreaming />, { container: host });
    expect(host.querySelector("[data-mermaid-diagram]")).toBeNull();
    expect(host.textContent).toContain("A --> B");
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
    await expect.element(view.getByText("Terminal failed")).toBeVisible();
    expect(execute).toHaveBeenCalledTimes(2);
    execute.mockResolvedValueOnce(undefined);
    await button.click();
    await expect.element(view.getByText("Terminal failed")).not.toBeInTheDocument();
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("uses a readable fallback for unknown terminal failures", async () => {
    const view = await render(
      <TerminalCommandProvider value={() => Promise.reject(null)}>
        <ChatMarkdown text={"```bash\necho hi\n```"} cwd={undefined} />
      </TerminalCommandProvider>,
    );
    await view.getByRole("button", { name: "Run in terminal" }).click();
    await expect.element(view.getByText("Could not run command. Try again.")).toBeVisible();
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
