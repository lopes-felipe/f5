import ChatMarkdown from "./ChatMarkdown";
import { RepositoryLinks } from "../repositoryLinkContext";
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

it("links repository references in rendered chat without changing code or existing links", async () => {
  const html = renderToStaticMarkup(
    <RepositoryLinks.Provider
      value={{ provider: "gitlab", webUrl: "https://gitlab.example/team/app" }}
    >
      <ChatMarkdown
        text={
          "Fix #123 and team/other#9, but `#456` and [#789](https://example.com) stay unchanged."
        }
        cwd="/tmp/project"
      />
    </RepositoryLinks.Provider>,
  );
  expect(html).toContain('href="https://gitlab.example/team/app/-/issues/123"');
  expect(html).toContain('href="https://gitlab.example/team/other/-/issues/9"');
  expect(html).not.toContain("/issues/456");
  expect(html).not.toContain("/issues/789");
});

it("leaves a file link with an unclosed angle-bracket destination as literal text", async () => {
  const { default: ChatMarkdown } = await import("./ChatMarkdown");
  const html = renderToStaticMarkup(
    <ChatMarkdown
      text="See [notes](</tmp/project/my notes.md) and [app](<./app.ts>)."
      cwd="/tmp/project"
    />,
  );
  // Upstream reverted automatic repair (t3code#15824); only the valid link becomes a chip.
  expect(html.match(/chat-markdown-file-link"/g)).toHaveLength(1);
  expect(html).toContain("[notes](&lt;/tmp/project/my notes.md)");
});

describe("ChatMarkdown external-bot policy", () => {
  const render = async (text: string) => {
    return renderToStaticMarkup(
      <RepositoryLinks.Provider value={{ provider: "github", webUrl: "https://github.com/o/r" }}>
        <ChatMarkdown text={text} cwd="/tmp/project" policy="external-bot" />
      </RepositoryLinks.Provider>,
    );
  };

  it("drops raw HTML", async () => {
    const html = await render('Hi <script>alert(1)</script><img src="x" onerror="y"> **there**');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("<strong>there</strong>");
  });

  it("renders images as text", async () => {
    const html = await render("![diagram](https://example.com/a.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("[diagram: https://example.com/a.png]");
  });

  it("keeps only HTTPS links, with noopener noreferrer", async () => {
    const html = await render(
      "[ok](https://example.com/x) [plain](http://example.com) [file](./app.ts) [abs](/etc/passwd) [js](javascript:alert(1))",
    );
    expect(html).toContain(
      '<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">ok</a>',
    );
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).not.toContain("chat-markdown-file-link");
    expect(html).toContain("plain");
    expect(html).toContain("file");
  });

  it("adds no PR previews or issue links", async () => {
    const html = await render("See https://github.com/o/r/pull/12 and #34.");
    expect(html).not.toContain("issues/34");
    expect(html).toContain('href="https://github.com/o/r/pull/12"');
    expect(html).not.toContain("pr-link-preview");
  });
});

it("keeps a descriptive file-link label beside the chip and drops a filename label", async () => {
  const { default: ChatMarkdown } = await import("./ChatMarkdown");
  const html = renderToStaticMarkup(
    <ChatMarkdown
      text="It [validates the input](/tmp/project/src/example.ts:12) in [example.ts:12](/tmp/project/src/example.ts:12)."
      cwd="/tmp/project"
    />,
  );
  expect(html.match(/chat-markdown-file-link"/g)).toHaveLength(2);
  expect(html).toContain("validates the input");
  expect(html.match(/chat-markdown-file-link-label">example\.ts</g)).toHaveLength(2);
  expect(html).not.toMatch(/in <span>example\.ts:12/);
});

it("keeps an unmatched <A> placeholder from linking later blocks", async () => {
  const { default: ChatMarkdown } = await import("./ChatMarkdown");
  const html = renderToStaticMarkup(
    <ChatMarkdown
      text={`- **"From <A>"** appears in the header.\n\n- **Tests:** cover inheritance.\n\nThe deferred move continues on B.`}
      cwd="/tmp/project"
    />,
  );
  // Chat markdown renders HTML as literal text, so the placeholder can never open a link.
  expect(html).toContain("<strong>&quot;From &lt;A&gt;&quot;</strong>");
  expect(html).not.toContain("<a");
  expect(html.match(/<li>/g)).toHaveLength(2);
  expect(html).toContain("<p>The deferred move continues on B.</p>");
});

it("keeps Windows path backslashes that CommonMark would read as escapes", async () => {
  const { default: ChatMarkdown } = await import("./ChatMarkdown");
  const html = renderToStaticMarkup(
    <ChatMarkdown
      text={[
        String.raw`[settings](C:\Users\shawn\.claude\settings.json)`,
        "[reference][shot]",
        String.raw`[shot]: C:\Users\shawn\.t3\notes.md`,
        "[amp](C:/Users/shawn/a&amp;b.md)",
      ].join("\n\n")}
      cwd="C:/Users/shawn"
    />,
  );
  // Without the plugin `\.` is an escape, and the paths lose the separator before `.claude`.
  expect(html).toContain('href="C:%5CUsers%5Cshawn%5C.claude%5Csettings.json"');
  expect(html).toContain('href="C:%5CUsers%5Cshawn%5C.t3%5Cnotes.md"');
  expect(html).toContain('href="C:/Users/shawn/a&amp;b.md"');
  expect(html.match(/chat-markdown-file-link"/g)).toHaveLength(3);
});

it("renders file URI links as chips but still empties unsafe schemes", async () => {
  const { default: ChatMarkdown } = await import("./ChatMarkdown");
  const html = renderToStaticMarkup(
    <ChatMarkdown
      text="[a.ts](file:///tmp/project/a.ts) and [run](javascript:alert(1))"
      cwd="/tmp/project"
    />,
  );
  expect(html).toContain('href="file:///tmp/project/a.ts" class="chat-markdown-file-link"');
  expect(html).not.toContain("javascript:");
});

it("marks image-only links so they render without an underline", async () => {
  const { default: ChatMarkdown } = await import("./ChatMarkdown");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChatMarkdown
        text="[![build](https://example.com/badge.svg)](https://example.com/ci) and [docs](https://example.com/docs)"
        cwd="/tmp/project"
      />
    </QueryClientProvider>,
  );
  expect(html.match(/data-markdown-image-link="true"/g)).toHaveLength(1);
  expect(html).toMatch(/<a data-markdown-image-link="true" href="https:\/\/example\.com\/ci"/);
});
