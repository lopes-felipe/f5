import "../index.css";

import { findThreadSearchOccurrences } from "@t3tools/shared/threadSearch";
import { searchableThreadSegments } from "@t3tools/shared/threadFindText";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { FileNavigationProvider } from "../fileNavigationContext";
import { threadFindRanges } from "./chat/threadFindHighlights";
import ChatMarkdown from "./ChatMarkdown";
import { toastManager } from "./ui/toast";

const clipboard = vi.hoisted(() => ({
  write: vi.fn(async (_value: string) => {}),
}));
vi.mock("../hooks/useCopyToClipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useCopyToClipboard")>()),
  writeTextToClipboard: (value: string) => clipboard.write(value),
}));

vi.mock("../lib/markdownHighlighter", () => ({
  getMarkdownHighlighter: () =>
    Promise.resolve({
      codeToHtml: (code: string) => {
        const pre = document.createElement("pre");
        pre.className = "shiki";
        const codeElement = pre.appendChild(document.createElement("code"));
        for (const line of code.split("\n")) {
          const span = codeElement.appendChild(document.createElement("span"));
          span.className = "line";
          span.textContent = line;
          codeElement.append("\n");
        }
        return pre.outerHTML;
      },
    }),
}));

afterEach(() => {
  clipboard.write.mockReset();
  clipboard.write.mockImplementation(async () => {});
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function linesOf(count: number, line: (index: number) => string) {
  return Array.from({ length: count }, (_, index) => line(index)).join("\n");
}

describe("code block header", () => {
  it("keeps Copy visible without hover and copies the complete source", async () => {
    const source = linesOf(40, (index) => `const v${index} = ${index};`);
    const view = await render(
      <ChatMarkdown text={`\`\`\`ts\n${source}\n\`\`\``} cwd={undefined} foldCodeBlocks />,
    );
    const copy = view.getByRole("button", { name: "Copy code" });
    await expect.element(copy).toBeVisible();
    expect(getComputedStyle(copy.element()).opacity).toBe("1");
    await copy.click();
    expect(clipboard.write).toHaveBeenCalledWith(`${source}\n`);
  });

  it("surfaces a copy failure as a toast", async () => {
    clipboard.write.mockRejectedValueOnce(new Error("Denied"));
    const add = vi.spyOn(toastManager, "add");
    const view = await render(<ChatMarkdown text={"```ts\nconst a = 1;\n```"} cwd={undefined} />);
    await view.getByRole("button", { name: "Copy code" }).click();
    await vi.waitFor(() =>
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", title: "Could not copy code" }),
      ),
    );
  });

  it("folds a long block and expands and collapses it", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const view = await render(
      <ChatMarkdown
        text={`\`\`\`ts\n${linesOf(60, (index) => `line ${index}`)}\n\`\`\``}
        cwd={undefined}
        foldCodeBlocks
      />,
      { container: host },
    );
    const block = host.querySelector<HTMLElement>(".chat-markdown-codeblock")!;
    const toggle = view.getByRole("button", { name: "Show all 60 lines" });
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    expect(block.dataset.folded).toBe("true");
    const pre = () => block.querySelector("pre")!;
    const foldedHeight = pre().getBoundingClientRect().height;
    expect(foldedHeight).toBeLessThan(30 * 21);

    await toggle.click();
    await expect.element(view.getByRole("button", { name: "Collapse" })).toBeVisible();
    expect(block.dataset.folded).toBeUndefined();
    expect(pre().getBoundingClientRect().height).toBeGreaterThan(foldedHeight * 2);

    await view.getByRole("button", { name: "Collapse" }).click();
    await expect.element(view.getByRole("button", { name: "Show all 60 lines" })).toBeVisible();
    expect(block.dataset.folded).toBe("true");
  });

  it("releases the fold while the row holds the active find match", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    host.dataset.threadFindActive = "true";
    await render(
      <ChatMarkdown
        text={`\`\`\`ts\n${linesOf(60, (index) => `line ${index}`)}\n\`\`\``}
        cwd={undefined}
        foldCodeBlocks
      />,
      { container: host },
    );
    const block = host.querySelector<HTMLElement>(".chat-markdown-codeblock")!;
    expect(block.dataset.folded).toBe("true");
    expect(getComputedStyle(block.querySelector("pre")!).maxHeight).toBe("none");
    expect(getComputedStyle(block.querySelector(".chat-markdown-codeblock-footer")!).display).toBe(
      "none",
    );
  });

  it("navigates from the header file chip", async () => {
    const navigate = vi.fn(() => true);
    const view = await render(
      <FileNavigationProvider value={navigate}>
        <ChatMarkdown text={"```ts:src/app.ts\nexport {};\n```"} cwd="/repo" />
      </FileNavigationProvider>,
    );
    const chip = view.getByRole("link", { name: "app.ts" });
    // Cmd/middle-click falls back to a file URL, never an in-app relative path.
    await expect.element(chip).toHaveAttribute("href", "file:///repo/src/app.ts");
    await chip.click();
    expect(navigate).toHaveBeenCalledWith("/repo/src/app.ts");
  });

  it("keeps the on-demand Highlight code action under the header", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const view = await render(
      <ChatMarkdown
        text={`\`\`\`ts\n${linesOf(4_500, (index) => `huge_${index}`)}\n\`\`\``}
        cwd={undefined}
      />,
      { container: host },
    );
    await expect.element(view.getByRole("button", { name: "Highlight code" })).toBeVisible();
    const header = host.querySelector(".chat-markdown-codeblock-header")!;
    expect(header.nextElementSibling?.getAttribute("data-code-highlight")).toBe("on-demand");
  });
});

describe("thread find alignment", () => {
  function domMatches(root: HTMLElement, query: string): Range[] {
    return threadFindRanges(root, query).ranges;
  }
  function serverCount(markdown: string, query: string) {
    return searchableThreadSegments(markdown).reduce(
      (count, segment) => count + findThreadSearchOccurrences(segment, query).length,
      0,
    );
  }

  it("ignores the language label and keeps occurrences aligned across a fold and Shiki", async () => {
    const markdown = `\`\`\`ts\n// TypeScript first\n${linesOf(40, (index) => `const a${index} = ${index};`)}\n// TypeScript second\n\`\`\``;
    const host = document.body.appendChild(document.createElement("div"));
    await render(<ChatMarkdown text={markdown} cwd={undefined} foldCodeBlocks />, {
      container: host,
    });
    expect(serverCount(markdown, "TypeScript")).toBe(2);
    expect(domMatches(host, "TypeScript")).toHaveLength(2);
    const second = threadFindRanges(host, "TypeScript", 1).selected!;
    expect(second.startContainer.textContent).toContain("TypeScript second");

    await vi.waitFor(() => expect(host.querySelector(".chat-markdown-shiki pre")).not.toBeNull());
    expect(domMatches(host, "TypeScript")).toHaveLength(2);
    expect(threadFindRanges(host, "TypeScript", 1).selected!.startContainer.textContent).toContain(
      "TypeScript second",
    );
  });

  it("highlights an alert body, not its title", async () => {
    const markdown = "> [!WARNING]\n> Warning: back up first.";
    const host = document.body.appendChild(document.createElement("div"));
    await render(<ChatMarkdown text={markdown} cwd={undefined} />, { container: host });
    expect(serverCount(markdown, "Warning")).toBe(1);
    const { ranges, selected } = threadFindRanges(host, "Warning");
    expect(ranges).toHaveLength(1);
    expect(selected!.startContainer.parentElement!.tagName).toBe("P");
  });

  it("does not count the Text label as an occurrence", async () => {
    const markdown = "```\nText body\n```";
    const host = document.body.appendChild(document.createElement("div"));
    await render(<ChatMarkdown text={markdown} cwd={undefined} />, { container: host });
    expect(serverCount(markdown, "Text")).toBe(1);
    expect(threadFindRanges(host, "Text").ranges).toHaveLength(1);
  });
});
