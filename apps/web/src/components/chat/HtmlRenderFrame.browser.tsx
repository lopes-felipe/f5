import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "../../index.css";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ThreadId } from "@t3tools/contracts";
import { updateAppSettings } from "../../appSettings";
import { HtmlRenderThemeProvider } from "../../hooks/useHtmlRenderTheme";
import { OpenLinkThread } from "../../hooks/useOpenLink";
import { BUILTIN_THEME_PALETTES } from "../../themePalette";
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
    String(input).includes("/attachments/html-")
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
  // The page shows bare on the thread, with no title bar of its own.
  expect(page.getByText("HTML widget", { exact: true }).query()).toBeNull();
  await page.getByRole("figure", { name: "HTML render: HTML widget" }).hover();
  await page.getByRole("button", { name: "Open full screen", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect.element(dialog.getByText("HTML widget", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Reset zoom", exact: true }))
    .toHaveTextContent("125%");
  for (let step = 0; step < 3; step++)
    await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "Zoom out", exact: true })).toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "Reset zoom", exact: true }))
    .toHaveTextContent("50%");
  await page.getByRole("button", { name: "Reset zoom", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Reset zoom", exact: true }))
    .toHaveTextContent("100%");
  await dialog.getByTitle("HTML widget", { exact: true }).click();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => page.getByRole("dialog").query()).toBeNull();
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
  // The page's 300px plus the 8px gutter on each side.
  await expect.poll(() => frame.query()?.getBoundingClientRect().height).toBe(316);
  await userEvent.wheel(frame, { delta: { y: 100 } });
  await expect.poll(() => thread.scrollTop).toBeGreaterThan(0);
});
it("holds the page's height with an empty busy box, not a skeleton, while it loads", async () => {
  vi.mocked(globalThis.fetch).mockImplementation(() => new Promise<Response>(() => undefined));
  active = await render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <HtmlRenderFrame
          reference={{ ...reference, attachmentId: "html-loading", height: 400 }}
          onImageExpand={vi.fn()}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  await expect.poll(() => document.querySelector('[aria-busy="true"]')).not.toBeNull();
  const loading = document.querySelector<HTMLElement>('[aria-busy="true"]')!;
  expect(loading.getBoundingClientRect().height).toBe(400);
  expect(loading.childElementCount).toBe(0);
  expect(document.querySelector('[data-slot="skeleton"]')).toBeNull();
});

let nextPage = 0;
/** A fresh attachment id, so no test starts from another test's remembered height. */
const freshReference = (height = 120) => ({
  attachmentId: `html-fresh-${++nextPage}`,
  title: "HTML widget",
  height,
});
function Harness(props: {
  reference: { attachmentId: string; title: string; height: number };
  appearance?: "light" | "dark";
  wrap?: (children: React.ReactNode) => React.ReactNode;
}) {
  const frame = <HtmlRenderFrame reference={props.reference} onImageExpand={vi.fn()} />;
  return (
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <HtmlRenderThemeProvider
          palette={BUILTIN_THEME_PALETTES[0]!}
          settings={{ uiFontFamily: "", monoFontFamily: "" }}
          appearance={props.appearance ?? "dark"}
        >
          {props.wrap ? props.wrap(frame) : frame}
        </HtmlRenderThemeProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
const inlineFrame = () => document.querySelector<HTMLIFrameElement>('iframe[title="HTML widget"]')!;
const frameHeight = () => inlineFrame()?.getBoundingClientRect().height;
function probes() {
  const reports: Array<{ source: MessageEventSource | null; data: Record<string, unknown> }> = [];
  const receive = (event: MessageEvent) => {
    if (event.data?.probe) reports.push({ source: event.source, data: event.data });
  };
  window.addEventListener("message", receive);
  return { reports, stop: () => window.removeEventListener("message", receive) };
}

it("fits a tall page inline and caps a very tall one, which scrolls inside", async () => {
  source = '<div style="height:3500px">Tall</div>';
  active = await render(<Harness reference={freshReference()} />);
  await expect.poll(frameHeight).toBe(3516);
  await active.unmount();
  source =
    '<div style="height:25000px">Very tall</div><script>setInterval(()=>parent.postMessage({probe:true,overflow:getComputedStyle(document.documentElement).overflow},"*"),50)</script>';
  const { reports, stop } = probes();
  try {
    active = await render(<Harness reference={freshReference()} />);
    await expect.poll(frameHeight).toBe(20_000);
    await expect.element(page.getByText(/This page is taller than 20,000px/)).toBeVisible();
    await expect.poll(() => reports.at(-1)?.data.overflow).toBe("auto");
    await page.getByRole("button", { name: "Open full screen", exact: true }).click();
    const fullscreen = page.getByRole("dialog").getByTitle("HTML widget", { exact: true });
    await expect.poll(() => fullscreen.query()?.getBoundingClientRect().height).toBe(25_016);
  } finally {
    stop();
  }
});

it("pauses a page that grows with its frame, and Retry sizing fits it again", async () => {
  source =
    "<style>body{min-height:100vh}</style><p>Grows</p><script>document.addEventListener('click',()=>{document.body.style.minHeight='0'})</script>";
  active = await render(<Harness reference={freshReference(300)} />);
  await expect.element(page.getByText(/Automatic sizing paused/)).toBeVisible();
  expect(frameHeight()).toBe(300);
  await page.getByTitle("HTML widget", { exact: true }).click();
  await page.getByRole("button", { name: "Retry sizing", exact: true }).click();
  await expect.poll(frameHeight).toBe(120);
  expect(page.getByText(/Automatic sizing paused/).query()).toBeNull();
});

it("starts a remounted page at its last measured height", async () => {
  const remembered = freshReference();
  source = '<div style="height:600px">Remembered</div>';
  active = await render(<Harness reference={remembered} />);
  await expect.poll(frameHeight).toBe(616);
  await active.unmount();
  vi.mocked(globalThis.fetch).mockImplementation(() => new Promise<Response>(() => undefined));
  active = await render(<Harness reference={remembered} />);
  await expect.poll(() => document.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(document.querySelector('[aria-busy="true"]')!.getBoundingClientRect().height).toBe(616);
});

it("reconnects a replaced document with the current theme and ignores the retired one", async () => {
  updateAppSettings({ loadRemoteImagesInChat: false });
  source =
    '<a style="display:block;height:200px" href="https://example.test/after">Link</a><script>parent.postMessage({probe:true,scheme:getComputedStyle(document.documentElement).colorScheme,background:getComputedStyle(document.documentElement).getPropertyValue("--background")},"*")</script>';
  const reference = freshReference();
  const { reports, stop } = probes();
  try {
    active = await render(<Harness reference={reference} appearance="dark" />);
    await expect.poll(frameHeight).toBe(216);
    await active.rerender(<Harness reference={reference} appearance="light" />);
    const retired = inlineFrame();
    updateAppSettings({ loadRemoteImagesInChat: true });
    await expect.poll(() => inlineFrame() !== retired).toBe(true);
    const fromFresh = () =>
      reports.filter((report) => report.source === inlineFrame().contentWindow).length;
    await expect.poll(fromFresh).toBe(1);
    const fresh = reports.find((report) => report.source === inlineFrame().contentWindow)!;
    expect(fresh.data.scheme).toBe("light");
    expect(fresh.data.background).toMatch(/^#[0-9a-f]{6}$/);
    expect(inlineFrame().srcdoc).toContain("img-src data: https:");
    await expect.poll(frameHeight).toBe(216);
    await page.getByTitle("HTML widget", { exact: true }).click();
    await expect.poll(() => api.openExternal.mock.calls).toEqual([["https://example.test/after"]]);
  } finally {
    stop();
    updateAppSettings({ loadRemoteImagesInChat: false });
  }
});

it("keeps typed input in the inline page across opening and closing full screen", async () => {
  source =
    '<input aria-label="Name" style="display:block;width:100%;height:150px"><script>setInterval(()=>parent.postMessage({probe:true,value:document.querySelector("input").value},"*"),50)</script>';
  const { reports, stop } = probes();
  try {
    active = await render(<Harness reference={freshReference()} />);
    await expect.poll(frameHeight).toBeGreaterThan(150);
    const inlineElement = inlineFrame();
    const inline = inlineElement.contentWindow;
    await page.getByTitle("HTML widget", { exact: true }).click();
    await userEvent.keyboard("kept");
    await expect
      .poll(() => reports.findLast((report) => report.source === inline)?.data.value)
      .toBe("kept");
    await page.getByRole("button", { name: "Open full screen", exact: true }).click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => page.getByRole("dialog").query()).toBeNull();
    expect(inlineFrame() === inlineElement).toBe(true);
    const after = reports.length;
    await expect.poll(() => reports.length).toBeGreaterThan(after);
    expect(reports.findLast((report) => report.source === inline)?.data.value).toBe("kept");
  } finally {
    stop();
  }
});

it("scrolls the thread sideways when the wheel turns horizontally over a page", async () => {
  source = '<p style="height:300px;margin:0">Hello</p>';
  active = await render(
    <Harness
      reference={freshReference()}
      wrap={(frame) => (
        <div data-testid="thread" style={{ height: "500px", width: "400px", overflow: "auto" }}>
          {frame}
          <div style={{ height: "1000px", width: "1200px" }} />
        </div>
      )}
    />,
  );
  const thread = page.getByTestId("thread").element();
  await expect.poll(frameHeight).toBe(316);
  await userEvent.wheel(page.getByTitle("HTML widget", { exact: true }), { delta: { x: 120 } });
  await expect.poll(() => thread.scrollLeft).toBeGreaterThan(0);
});
