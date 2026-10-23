import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "../../index.css";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ThreadId } from "@t3tools/contracts";
import { OpenLinkThread } from "../../hooks/useOpenLink";
import { useRightPanelStore } from "../../rightPanelStore";
import { TooltipProvider } from "../ui/tooltip";
import { HtmlRenderFrame } from "./HtmlRenderFrame";

const api = vi.hoisted(() => ({
  bindings: [] as import("@t3tools/contracts").ResolvedKeybindingsConfig,
  openExternal: vi.fn(async () => undefined),
}));
vi.mock("../../nativeApi", () => ({
  readNativeApi: () => ({
    shell: api,
    server: { getConfig: async () => ({ keybindings: api.bindings }) },
  }),
  ensureNativeApi: () => ({
    shell: api,
    server: { getConfig: async () => ({ keybindings: api.bindings }) },
  }),
}));
const reference = { attachmentId: "html-page", title: "HTML widget", height: 120 };
const originalFetch = globalThis.fetch;
let source = "";
let active: Awaited<ReturnType<typeof render>> | undefined;
beforeEach(() => {
  source = "<p>Hello</p>";
  api.bindings = [];
  api.openExternal.mockClear();
  localStorage.clear();
  window.desktopBridge = {
    openExternal: api.openExternal,
    setTheme: async () => undefined,
  } as never;
  useRightPanelStore.setState({ byThreadId: {}, closedHistory: [] });
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    String(input).includes("/attachments/html-page")
      ? Promise.resolve(new Response(source, { headers: { "content-type": "text/html" } }))
      : originalFetch(input, init),
  );
});
afterEach(async () => {
  await active?.unmount();
  active = undefined;
  delete window.desktopBridge;
  vi.restoreAllMocks();
});
async function mount(onImageExpand = vi.fn(), owner?: ThreadId) {
  active = await render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <OpenLinkThread.Provider value={owner}>
        <TooltipProvider>
          <HtmlRenderFrame reference={reference} onImageExpand={onImageExpand} />
        </TooltipProvider>
      </OpenLinkThread.Provider>
    </QueryClientProvider>,
  );
  await expect
    .poll(() => document.querySelector<HTMLIFrameElement>('iframe[title="HTML widget"]')?.srcdoc)
    .toContain("Hello");
}
it("runs JavaScript in an opaque sandbox that cannot access the parent or Node", async () => {
  const reports: unknown[] = [];
  const receive = (event: MessageEvent) => {
    if (event.data?.probe) reports.push(event.data);
  };
  window.addEventListener("message", receive);
  source =
    '<p>Hello</p><script>let parentAccess=false;try{parentAccess=!!parent.document.body}catch{}parent.postMessage({probe:true,parentAccess,node:typeof process,require:typeof require},"*");</script>';
  try {
    await mount();
    await expect
      .poll(() => reports)
      .toEqual([{ probe: true, parentAccess: false, node: "undefined", require: "undefined" }]);
    expect(document.querySelector('iframe[title="HTML widget"]')?.getAttribute("sandbox")).toBe(
      "allow-scripts",
    );
    expect(
      document.querySelector<HTMLIFrameElement>('iframe[title="HTML widget"]')?.srcdoc,
    ).toContain("default-src 'none'");
  } finally {
    window.removeEventListener("message", receive);
  }
});
it("opens links externally without navigating the parent", async () => {
  source =
    '<a style="display:block;height:120px;width:100%" href="https://example.test/review">Hello</a>';
  await mount();
  await page.getByTitle("HTML widget", { exact: true }).click();
  await expect.poll(() => api.openExternal.mock.calls).toEqual([["https://example.test/review"]]);
});
it("opens pull request links beside the thread, like chat links", async () => {
  const thread = ThreadId.makeUnsafe("html-render-owner");
  source =
    '<a style="display:block;height:120px;width:100%" href="https://github.com/org/repo/pull/7">Hello</a>';
  await mount(vi.fn(), thread);
  await page.getByTitle("HTML widget", { exact: true }).click();
  await expect
    .poll(() => useRightPanelStore.getState().byThreadId[thread]?.activeSurfaceId)
    .toBe("pr:github:github.com/org/repo#7");
  expect(api.openExternal).not.toHaveBeenCalled();
});
it("opens rendered images through the existing image viewer", async () => {
  const image = vi.fn();
  const src =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  source = `<p style="display:none">Hello</p><img alt="Diagram" style="display:block;height:120px;width:100%" src="${src}">`;
  await mount(image);
  await page.getByTitle("HTML widget", { exact: true }).click();
  await expect.poll(() => image.mock.calls.length).toBe(1);
  expect(image.mock.calls[0]![0].images[0]).toMatchObject({
    src,
    name: "Diagram",
    mimeType: "image/png",
  });
});
it("supports fullscreen zoom and returns inline when Escape is pressed inside the frame", async () => {
  await mount();
  await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect.element(page.getByText("110%", { exact: true })).toBeVisible();
  await page.getByTitle("HTML widget", { exact: true }).click();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => page.getByRole("dialog").query()).toBeNull();
  await expect.element(page.getByRole("button", { name: "Fullscreen", exact: true })).toBeVisible();
});

it("ignores forged page commands and extra channel handshakes", async () => {
  source = `<p>Hello</p><script>parent.postMessage({f5HtmlRender:__f5Bridge,type:'link',value:'https://forged.test/'},'*');const fake=new MessageChannel();parent.postMessage({f5HtmlRender:__f5Bridge,type:'connect'},'*',[fake.port2]);fake.port1.postMessage({f5HtmlRender:__f5Bridge,type:'link',value:'https://forged.test/'});</script>`;
  await mount();
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  expect(api.openExternal).not.toHaveBeenCalled();
});

it("forwards configured trusted shortcuts using captured native key getters", async () => {
  api.bindings = [
    {
      command: "commandPalette.toggle",
      shortcut: {
        key: "k",
        ctrlKey: true,
        metaKey: false,
        modKey: false,
        shiftKey: false,
        altKey: false,
      },
    },
  ];
  source = `<p>Hello</p><script>Object.defineProperty(KeyboardEvent.prototype,'key',{get(){return 'Delete'}});</script>`;
  const keys: string[] = [];
  const receive = (event: KeyboardEvent) => {
    if (!event.isTrusted) keys.push(event.key);
  };
  window.addEventListener("keydown", receive);
  try {
    await mount();
    await page.getByTitle("HTML widget", { exact: true }).click();
    await userEvent.keyboard("{Control>}k{/Control}");
    await expect.poll(() => keys).toContain("k");
    expect(keys).not.toContain("Delete");
  } finally {
    window.removeEventListener("keydown", receive);
  }
});
it("scrolls the thread when the wheel turns over an inline page", async () => {
  source = '<p style="height:300px;margin:0">Hello</p>';
  active = await render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <div data-testid="thread" style={{ height: "500px", overflowY: "auto" }}>
          <HtmlRenderFrame reference={reference} onImageExpand={vi.fn()} />
          <div style={{ height: "1000px" }} />
        </div>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  const thread = page.getByTestId("thread").element();
  const frame = page.getByTitle("HTML widget", { exact: true });
  // The reported height shows the page's script is connected and handling the wheel.
  await expect.poll(() => frame.query()?.getBoundingClientRect().height).toBe(300);
  await userEvent.wheel(frame, { delta: { y: 100 } });
  await expect.poll(() => thread.scrollTop).toBeGreaterThan(0);
});
it("holds the page's height with a skeleton while the page loads", async () => {
  vi.mocked(globalThis.fetch).mockImplementation(() => new Promise<Response>(() => undefined));
  active = await render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <HtmlRenderFrame reference={{ ...reference, height: 400 }} onImageExpand={vi.fn()} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  const skeleton = page.getByRole("status", { name: "Loading page…" });
  await expect.element(skeleton).toBeVisible();
  expect(skeleton.element().getBoundingClientRect().height).toBe(384);
});
