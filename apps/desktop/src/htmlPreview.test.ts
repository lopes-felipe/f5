import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThreadId } from "@t3tools/contracts";
import {
  createHtmlPreviewRenderer,
  registerHtmlPreviewIpc,
  HTML_PREVIEW_CHANNEL,
} from "./htmlPreview";

const state = vi.hoisted(() => ({
  windows: [] as Array<{
    options: unknown;
    destroyed: boolean;
    destroy: ReturnType<typeof vi.fn>;
    webContents: {
      on: ReturnType<typeof vi.fn>;
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
}));
vi.mock("electron", () => ({
  BrowserWindow: class {
    destroyed = false;
    url = "";
    destroy = vi.fn(() => {
      this.destroyed = true;
    });
    webContents = {
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      session: {
        clearStorageData: vi.fn(async () => undefined),
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
      },
      executeJavaScript: vi.fn(async () => 640),
      capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from("png") })),
    };
    constructor(readonly options: unknown) {
      state.windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    loadURL(url: string) {
      this.url = url;
      return state.hang ? new Promise<void>(() => undefined) : Promise.resolve();
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
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await first).toMatchObject({
    _tag: "Unavailable",
    message: expect.stringContaining("15 seconds"),
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
