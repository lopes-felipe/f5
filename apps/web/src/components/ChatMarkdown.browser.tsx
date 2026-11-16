import "../index.css";

import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { setCodeHighlightWorkerFactoryForTests } from "../lib/codeHighlightWorkerClient";
import type { DiffThemeName } from "../lib/diffRendering";
import { SuspenseShikiCodeBlock, createHighlightCacheKey } from "./ChatMarkdown";

const highlightCalls: Array<{ code: string; lang: string; theme: string }> = [];

vi.mock("../lib/markdownHighlighter", () => ({
  getMarkdownHighlighter: () =>
    Promise.resolve({
      codeToHtml: (code: string, options: { lang: string; theme: string }) => {
        highlightCalls.push({ code, lang: options.lang, theme: options.theme });
        const pre = document.createElement("pre");
        pre.dataset.lang = options.lang;
        pre.dataset.theme = options.theme;
        pre.textContent = code;
        return pre.outerHTML;
      },
    }),
}));

const LIGHT: DiffThemeName = "pierre-light";
const DARK: DiffThemeName = "pierre-dark";

function Block(props: { code: string; className?: string; themeName?: DiffThemeName }) {
  return (
    <Suspense fallback={<pre data-testid="fallback">{props.code}</pre>}>
      <SuspenseShikiCodeBlock
        className={props.className ?? "language-ts"}
        code={props.code}
        themeName={props.themeName ?? LIGHT}
      />
    </Suspense>
  );
}

async function highlighted(host: HTMLElement): Promise<HTMLElement> {
  await vi.waitFor(() => {
    expect(host.querySelector(".chat-markdown-shiki pre")).not.toBeNull();
  });
  return host.querySelector(".chat-markdown-shiki pre") as HTMLElement;
}

describe("SuspenseShikiCodeBlock", () => {
  afterEach(() => {
    highlightCalls.length = 0;
    document.body.innerHTML = "";
  });

  it("rerenders a block across a cache miss and hit without a hook-order error", async () => {
    const errors = vi.spyOn(console, "error");
    const host = document.body.appendChild(document.createElement("div"));
    const code = `const missThenHit = ${Date.now()};`;
    const screen = await render(<Block code={code} />, { container: host });
    expect((await highlighted(host)).textContent).toBe(code);

    // The miss stored the HTML from its effect; this render is a hit.
    await screen.rerender(<Block code={code} />);
    await screen.rerender(<Block code={code} />);
    expect((await highlighted(host)).textContent).toBe(code);
    expect(highlightCalls.filter((call) => call.code === code)).toHaveLength(1);
    expect(errors.mock.calls.some((call) => String(call[0]).includes("Rendered fewer hooks"))).toBe(
      false,
    );
  });

  it("highlights again when the theme or language changes", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const code = `let switching = ${Date.now()};`;
    const screen = await render(<Block code={code} />, { container: host });
    expect((await highlighted(host)).dataset.theme).toBe(LIGHT);

    await screen.rerender(<Block code={code} themeName={DARK} />);
    await vi.waitFor(async () => expect((await highlighted(host)).dataset.theme).toBe(DARK));

    await screen.rerender(<Block code={code} themeName={DARK} className="language-py" />);
    await vi.waitFor(async () => expect((await highlighted(host)).dataset.lang).toBe("py"));

    await screen.rerender(<Block code={code} />);
    const restored = await highlighted(host);
    expect(restored.dataset.theme).toBe(LIGHT);
    expect(restored.dataset.lang).toBe("ts");
  });

  it("renders each of two equal-length sources with colliding 32-bit hashes", async () => {
    const first = "0j686fc1krm9cc";
    const second = "1w14t770fhxsnq";
    expect(createHighlightCacheKey(first, "ts", LIGHT)).not.toBe(
      createHighlightCacheKey(second, "ts", LIGHT),
    );

    const firstHost = document.body.appendChild(document.createElement("div"));
    await render(<Block code={first} />, { container: firstHost });
    expect((await highlighted(firstHost)).textContent).toBe(first);

    const secondHost = document.body.appendChild(document.createElement("div"));
    await render(<Block code={second} />, { container: secondHost });
    expect((await highlighted(secondHost)).textContent).toBe(second);
  });
});

describe("SuspenseShikiCodeBlock size limits", () => {
  afterEach(() => {
    setCodeHighlightWorkerFactoryForTests(null);
    highlightCalls.length = 0;
    document.body.innerHTML = "";
  });

  const linesOf = (count: number, seed: string) =>
    Array.from({ length: count }, (_, index) => `const ${seed}${index} = ${index};`).join("\n");

  it("highlights large fences in a worker instead of the main thread", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const code = linesOf(600, `worker${Date.now()}_`);
    await render(<Block code={code} />, { container: host });

    expect(host.querySelector('[data-code-highlight="pending"] pre')?.textContent).toBe(code);
    await vi.waitFor(
      () => expect(host.querySelector(".chat-markdown-shiki pre.shiki")).not.toBeNull(),
      { timeout: 15_000 },
    );
    expect(highlightCalls.some((call) => call.code === code)).toBe(false);
  });

  it("shows huge fences as plain text and highlights them on demand", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const code = linesOf(4_500, `huge${Date.now()}_`);
    await render(<Block code={code} />, { container: host });

    expect(host.querySelector('[data-code-highlight="on-demand"] pre')?.textContent).toBe(code);
    expect(host.querySelector(".chat-markdown-shiki")).toBeNull();

    const button = Array.from(host.querySelectorAll("button")).find(
      (element) => element.textContent === "Highlight code",
    );
    button!.click();
    await vi.waitFor(
      () => expect(host.querySelector(".chat-markdown-shiki pre.shiki")).not.toBeNull(),
      { timeout: 20_000 },
    );
  });

  it("keeps a 'Highlight code' opt-in while the block keeps streaming", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const code = linesOf(4_500, `streamed${Date.now()}_`);
    const screen = await render(<Block code={code} />, { container: host });
    Array.from(host.querySelectorAll("button"))
      .find((element) => element.textContent === "Highlight code")!
      .click();

    const grown = `${code}\nconst tail = 1;`;
    await screen.rerender(<Block code={grown} />);

    expect(host.querySelector('[data-code-highlight="on-demand"]')).toBeNull();
    await vi.waitFor(
      () =>
        expect(host.querySelector(".chat-markdown-shiki pre.shiki")?.textContent).toContain(
          "const tail = 1;",
        ),
      { timeout: 20_000 },
    );
  });

  it("highlights unsupported languages in the worker as plain text", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const code = linesOf(600, `klingon${Date.now()}_`);
    await render(<Block code={code} className="language-klingon" />, { container: host });

    await vi.waitFor(
      () => expect(host.querySelector(".chat-markdown-shiki pre")?.textContent).toBe(code),
      { timeout: 15_000 },
    );
  });

  it("keeps plain text when the worker fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setCodeHighlightWorkerFactoryForTests(() => {
      const worker = new EventTarget() as EventTarget & Worker;
      Object.assign(worker, {
        postMessage: () => {
          queueMicrotask(() => {
            const event = new Event("error") as ErrorEvent;
            Object.defineProperty(event, "message", { value: "boom" });
            worker.dispatchEvent(event);
          });
        },
        terminate: () => undefined,
      });
      return worker;
    });
    const host = document.body.appendChild(document.createElement("div"));
    const code = linesOf(600, `failing${Date.now()}_`);
    await render(<Block code={code} />, { container: host });

    await vi.waitFor(() =>
      expect(host.querySelector('[data-code-highlight="failed"] pre')?.textContent).toBe(code),
    );
    expect(host.querySelector(".chat-markdown-shiki")).toBeNull();
    warn.mockRestore();
  });
});
