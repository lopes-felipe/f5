import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HTML_PREVIEW_RENDER_DEADLINE_MS, ThreadId } from "@t3tools/contracts";
import {
  createHtmlPreviewRenderer,
  logSafeErrorText,
  registerHtmlPreviewIpc,
  HTML_PREVIEW_CHANNEL,
  MEASURE_SCRIPT,
  SETTLE_SCRIPT,
} from "./htmlPreview";
import { HTML_RENDER_MEASURE_SOURCE } from "@t3tools/shared/htmlRender";

const state = vi.hoisted(() => ({
  windows: [] as Array<{
    options: unknown;
    destroyed: boolean;
    destroy: ReturnType<typeof vi.fn>;
    webContents: {
      on: ReturnType<typeof vi.fn>;
      debugger: {
        attach: ReturnType<typeof vi.fn>;
        sendCommand: ReturnType<typeof vi.fn>;
        detach: ReturnType<typeof vi.fn>;
      };
      executeJavaScript: ReturnType<typeof vi.fn>;
      setWindowOpenHandler: ReturnType<typeof vi.fn>;
      session: {
        clearStorageData: ReturnType<typeof vi.fn>;
        setPermissionRequestHandler: ReturnType<typeof vi.fn>;
        setPermissionCheckHandler: ReturnType<typeof vi.fn>;
      };
    };
    url: string;
  }>,
  hang: false,
  order: [] as string[],
  emulation: "resolve" as "resolve" | "afterLoad" | "never",
  loaded: undefined as (() => void) | undefined,
  attachFails: false,
  emulationFails: false,
  detachFails: false,
  captureError: undefined as Error | undefined,
}));
vi.mock("electron", () => ({
  BrowserWindow: class {
    destroyed = false;
    url = "";
    destroy = vi.fn(() => {
      state.order.push("destroy");
      this.destroyed = true;
    });
    webContents = {
      on: vi.fn(),
      debugger: {
        attach: vi.fn(() => {
          state.order.push("attach");
          if (state.attachFails) throw new Error("attach");
        }),
        sendCommand: vi.fn(async () => {
          state.order.push("emulate");
          if (state.emulationFails) throw new Error("emulate");
          // Like Blink: the command is only answered once a renderer has loaded a page.
          if (state.emulation === "afterLoad" && !state.loaded)
            await new Promise<void>((resolve) => (state.loaded = resolve));
          if (state.emulation === "never") await new Promise<void>(() => undefined);
        }),
        detach: vi.fn(() => {
          state.order.push("detach");
          if (state.detachFails) throw new Error("detach");
        }),
      },
      setWindowOpenHandler: vi.fn(),
      session: {
        clearStorageData: vi.fn(async () => undefined),
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
      },
      executeJavaScript: vi.fn(async () => 640),
      capturePage: vi.fn(async () => {
        if (state.captureError) throw state.captureError;
        return { toPNG: () => Buffer.from("png") };
      }),
    };
    constructor(readonly options: unknown) {
      state.windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    loadURL(url: string) {
      state.order.push(url === "about:blank" ? "blank" : "load");
      this.url = url;
      if (state.loaded === undefined) state.loaded = () => undefined;
      return state.hang && url.startsWith("data:")
        ? new Promise<void>(() => undefined)
        : Promise.resolve();
    }
    setContentSize() {}
  },
}));
const input = {
  requestId: "preview",
  threadId: ThreadId.makeUnsafe("t"),
  html: "<p>Hello</p>",
  width: 728,
  appearance: "dark" as const,
};
beforeEach(() => {
  state.windows.length = 0;
  state.hang = false;
  state.order.length = 0;
  state.attachFails = false;
  state.emulationFails = false;
  state.detachFails = false;
  state.emulation = "resolve";
  state.loaded = undefined;
  state.captureError = undefined;
});
afterEach(() => vi.useRealTimers());
it("renders in an offscreen isolated sandbox, blocks navigation and destroys the window", async () => {
  const result = await createHtmlPreviewRenderer()(input);
  expect(result).toMatchObject({
    _tag: "Ready",
    contentHeight: 640,
    capturedHeight: 640,
    width: 728,
  });
  const window = state.windows[0]!;
  expect(window.options).toMatchObject({
    show: false,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  expect(window.webContents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({ action: "deny" });
  for (const name of ["will-navigate", "will-redirect", "will-attach-webview"]) {
    const preventDefault = vi.fn();
    window.webContents.on.mock.calls.find((call) => call[0] === name)![1]({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  }
  expect(decodeURIComponent(window.url)).toContain("default-src 'none'");
  expect(window.destroy).toHaveBeenCalledOnce();
});
it("caps concurrent renders and destroys hung pages at the deadline", async () => {
  vi.useFakeTimers();
  state.hang = true;
  const render = createHtmlPreviewRenderer();
  const first = render(input),
    second = render(input);
  expect(await render(input)).toMatchObject({
    _tag: "Unavailable",
    message: expect.stringContaining("busy"),
  });
  await vi.advanceTimersByTimeAsync(HTML_PREVIEW_RENDER_DEADLINE_MS);
  expect(await first).toMatchObject({
    _tag: "Unavailable",
    message: "HTML preview timed out while loading page after 12 seconds.",
  });
  await second;
  expect(state.windows.every((window) => window.destroyed)).toBe(true);
});
it("requires owning-main-frame authorization before parsing or allocating a render", () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, value: unknown) => unknown>();
  const ipc = {
    handle: (name: string, handler: (event: IpcMainInvokeEvent, value: unknown) => unknown) =>
      handlers.set(name, handler),
    removeHandler: vi.fn(),
  };
  registerHtmlPreviewIpc(ipc as unknown as IpcMain, () => {
    throw new Error("Untrusted frame");
  });
  expect(() => handlers.get(HTML_PREVIEW_CHANNEL)!({} as IpcMainInvokeEvent, input)).toThrow(
    "Untrusted frame",
  );
  expect(state.windows).toHaveLength(0);
});

it("emulates the color scheme once a renderer exists, again on the document, and measures with the shared expression", async () => {
  const theme = { appearance: "light" as const, variables: { "--background": "#fafafa" } };
  const result = await createHtmlPreviewRenderer()({ ...input, appearance: "light", theme });
  expect(result).toMatchObject({ _tag: "Ready" });
  const window = state.windows[0]!;
  expect(state.order).toEqual([
    "blank",
    "attach",
    "emulate",
    "load",
    "emulate",
    "detach",
    "destroy",
  ]);
  expect(window.webContents.debugger.sendCommand).toHaveBeenCalledWith(
    "Emulation.setEmulatedMedia",
    { features: [{ name: "prefers-color-scheme", value: "light" }] },
  );
  expect(window.webContents.executeJavaScript.mock.calls[0]![0]).toContain(
    HTML_RENDER_MEASURE_SOURCE,
  );
  const page = decodeURIComponent(window.url);
  expect(page).toContain("--background:#fafafa");
  expect(page).toContain("color-scheme:light");
});

it("keeps the legacy colors for a request without a theme", async () => {
  await createHtmlPreviewRenderer()(input);
  expect(decodeURIComponent(state.windows[0]!.url)).toContain(
    "--background:#18181b;--foreground:#fafafa",
  );
});

it.each(["attachFails", "emulationFails"] as const)(
  "still renders and logs the skip when the debugger is unavailable (%s)",
  async (failure) => {
    state[failure] = true;
    const log = vi.fn();
    expect(await createHtmlPreviewRenderer(log)(input)).toMatchObject({ _tag: "Ready" });
    expect(state.order).toContain("load");
    expect(state.windows[0]!.destroyed).toBe(true);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![0]).toMatch(
      /^html preview emulation skipped error="(attach|emulate)" stage="emulating color scheme" ms=\d+$/,
    );
  },
);

it("destroys the window and frees its slot when detaching fails", async () => {
  state.detachFails = true;
  const render = createHtmlPreviewRenderer();
  for (let attempt = 0; attempt < 3; attempt++)
    expect(await render(input)).toMatchObject({ _tag: "Ready" });
  expect(state.windows.every((window) => window.destroyed)).toBe(true);
});

it("does not deadlock when emulation waits for a live renderer", async () => {
  vi.useFakeTimers();
  state.emulation = "afterLoad";
  const log = vi.fn();
  const pending = createHtmlPreviewRenderer(log)(input);
  await vi.advanceTimersByTimeAsync(HTML_PREVIEW_RENDER_DEADLINE_MS);
  expect(await pending).toMatchObject({ _tag: "Ready" });
  // Emulating before any page loaded would go unanswered and be skipped.
  expect(log).not.toHaveBeenCalled();
  expect(state.order.indexOf("blank")).toBeLessThan(state.order.indexOf("emulate"));
});

it("skips color-scheme emulation that never answers, and says so once", async () => {
  vi.useFakeTimers();
  state.emulation = "never";
  const log = vi.fn();
  const pending = createHtmlPreviewRenderer(log)(input);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await pending).toMatchObject({ _tag: "Ready" });
  expect(state.order.filter((step) => step === "emulate")).toHaveLength(1);
  expect(log).toHaveBeenCalledOnce();
  expect(log.mock.calls[0]![0]).toContain('emulation skipped error="no answer"');
});

/** Runs a page-side script against stubbed page globals. */
const runPageScript = (script: string, globals: Record<string, unknown>) =>
  new Function(...Object.keys(globals), `return ${script}`)(
    ...Object.values(globals),
  ) as Promise<unknown>;

it("measures even when fonts never finish loading", async () => {
  vi.useFakeTimers();
  const measured = runPageScript(MEASURE_SCRIPT, {
    document: {
      fonts: { ready: new Promise(() => undefined) },
      documentElement: { clientHeight: 100, scrollHeight: 640 },
    },
    setTimeout,
  });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await measured).toBe(640);
});

it("settles frames even when requestAnimationFrame never fires", async () => {
  vi.useFakeTimers();
  let settled = false;
  void runPageScript(SETTLE_SCRIPT, {
    requestAnimationFrame: () => undefined,
    setTimeout,
    clearTimeout,
  }).then(() => (settled = true));
  await vi.advanceTimersByTimeAsync(499);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBe(true);
});

it("logs the stalled stage once when the deadline passes", async () => {
  vi.useFakeTimers();
  state.hang = true;
  const log = vi.fn();
  const pending = createHtmlPreviewRenderer(log)(input);
  await vi.advanceTimersByTimeAsync(HTML_PREVIEW_RENDER_DEADLINE_MS);
  await pending;
  expect(log).toHaveBeenCalledOnce();
  expect(log.mock.calls[0]![0]).toMatch(/^html preview timed out stage="loading page" ms=\d+$/);
});

it("names the failed stage and logs a sanitized error", async () => {
  state.captureError = new Error(
    "capture failed for data:text/html;charset=utf-8,%3Cp%3Esecret\nforged line",
  );
  const log = vi.fn();
  expect(await createHtmlPreviewRenderer(log)(input)).toEqual({
    _tag: "Unavailable",
    message: "The desktop could not render this HTML preview (capturing).",
  });
  expect(log).toHaveBeenCalledOnce();
  const line = log.mock.calls[0]![0] as string;
  expect(line).toMatch(
    /^html preview failed error="capture failed for data:<omitted> forged line" stage="capturing" ms=\d+$/,
  );
  expect(line).not.toContain("secret");
  expect(state.windows[0]!.destroyed).toBe(true);
});

it("keeps logged error text to one bounded line", () => {
  expect(logSafeErrorText(new Error(`a\r\nb${"x".repeat(300)}`))).toMatch(/^a bx{197}$/);
  expect(logSafeErrorText("not an error")).toBe("unknown");
});
