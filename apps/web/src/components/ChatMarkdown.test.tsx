import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// ChatMarkdown pulls in shiki, the native API, and the file-navigation
// context. Stub them out so the test exercises only the streaming-lite vs
// settled render split.
vi.mock("@pierre/diffs", () => ({
  getSharedHighlighter: () =>
    Promise.resolve({
      codeToHtml: (code: string) => `<pre data-shiki-stub="true">${code}</pre>`,
    }),
  SupportedLanguages: {},
  // eslint-disable-next-line typescript-eslint/no-extraneous-class
  DiffsHighlighter: class DiffsHighlighterStub {},
}));

vi.mock("../fileNavigationContext", () => ({
  useFileNavigation: () => () => false,
}));

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({
    theme: "light" as const,
    resolvedTheme: "light" as const,
    setTheme: () => {},
  }),
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => null,
}));

vi.mock("./chat/VscodeEntryIcon", () => ({
  VscodeEntryIcon: () => null,
}));

const STREAMING_FIXTURE = [
  "Intro with **bold text** and a list:",
  "",
  "- first",
  "- second",
  "",
  "See [app.ts](./app.ts) for details.",
  "",
  "```ts",
  "const x = 1;",
].join("\n");

const SETTLED_FIXTURE = `${STREAMING_FIXTURE}\n\`\`\``;

async function renderMarkup(text: string, isStreaming: boolean): Promise<string> {
  const { default: ChatMarkdown } = await import("./ChatMarkdown");
  return renderToStaticMarkup(
    <ChatMarkdown text={text} cwd="/tmp/project" isStreaming={isStreaming} />,
  );
}

describe("ChatMarkdown streaming vs settled rendering", () => {
  it("renders sealed markdown blocks while keeping an open fence cheap during streaming", async () => {
    const markup = await renderMarkup(STREAMING_FIXTURE, true);

    expect(markup).toContain("<strong>bold text</strong>");
    expect(markup).toContain("<ul>");
    expect(markup).toContain("<li>first</li>");
    expect(markup).toContain("chat-markdown-file-link");

    // The still-open fence stays in the cheap preview path until it closes.
    expect(markup).toContain("```ts");
    expect(markup).toContain("const x = 1;");
    expect(markup).not.toContain("chat-markdown-codeblock");
    expect(markup).not.toContain("data-shiki-stub");
  });

  it("renders the full markdown pipeline once settled", async () => {
    const markup = await renderMarkup(SETTLED_FIXTURE, false);

    expect(markup).toContain("<strong>bold text</strong>");
    expect(markup).toContain("<ul>");
    expect(markup).toContain("<li>first</li>");
    expect(markup).toContain("chat-markdown-file-link");
    // The code fence is wrapped by MarkdownCodeBlock's copy-button container.
    expect(markup).toContain("chat-markdown-codeblock");
    expect(markup).toContain('<pre><code class="language-ts">const x = 1;');
  });
});
