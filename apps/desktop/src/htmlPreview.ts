import { randomUUID } from "node:crypto";
import { BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron";
import {
  HTML_RENDER_MAX_PAGE_BYTES,
  HtmlPreviewRequest,
  type HtmlPreviewResult,
} from "@t3tools/contracts";
import { htmlRenderDocument } from "@t3tools/shared/htmlRender";
import { Schema } from "effect";

export const HTML_PREVIEW_CHANNEL = "desktop:html-preview";
const unavailable = (message: string): HtmlPreviewResult => ({ _tag: "Unavailable", message });

export function createHtmlPreviewRenderer() {
  const busy = new Set<number>();
  const partitionPrefix = `f5-html-${randomUUID()}`;
  return async (value: unknown): Promise<HtmlPreviewResult> => {
    const input = Schema.decodeUnknownSync(HtmlPreviewRequest)(value);
    if (Buffer.byteLength(input.html) > HTML_RENDER_MAX_PAGE_BYTES)
      return unavailable("The HTML preview exceeds 25 MiB.");
    if (busy.size >= 2) return unavailable("HTML preview is busy. Retry shortly.");
    const slot = busy.has(0) ? 1 : 0;
    busy.add(slot);
    let window: BrowserWindow | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      window = new BrowserWindow({
        show: false,
        width: input.width,
        height: 800,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          javascript: true,
          webSecurity: true,
          offscreen: true,
          backgroundThrottling: false,
          partition: `${partitionPrefix}-${slot}`,
        },
      });
      const owner = window;
      owner.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      owner.webContents.on("will-navigate", (event) => event.preventDefault());
      owner.webContents.on("will-redirect", (event) => event.preventDefault());
      owner.webContents.on("will-attach-webview", (event) => event.preventDefault());
      owner.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      owner.webContents.session.setPermissionCheckHandler(() => false);
      const consoleMessages: string[] = [];
      owner.webContents.on("console-message", (details) => {
        if (consoleMessages.length < 100) consoleMessages.push(details.message.slice(0, 1000));
      });
      const render = async (): Promise<HtmlPreviewResult> => {
        // Agent-requested and unattended, so remote content never loads here.
        const html = htmlRenderDocument(input.html, {
          appearance: input.appearance,
          variables: {
            "--background": input.appearance === "light" ? "#ffffff" : "#18181b",
            "--foreground": input.appearance === "light" ? "#18181b" : "#fafafa",
          },
        });
        await owner.webContents.session.clearStorageData();
        if (owner.isDestroyed()) return unavailable("HTML preview was cancelled.");
        await owner.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        const height: unknown = await owner.webContents.executeJavaScript(
          "document.fonts.ready.then(()=>Math.ceil(Math.max(document.documentElement.scrollHeight,document.body?.scrollHeight||1)))",
        );
        const contentHeight =
          typeof height === "number" && Number.isFinite(height)
            ? Math.max(1, Math.min(100_000, Math.ceil(height)))
            : 800;
        const capturedHeight = Math.min(2000, contentHeight);
        owner.setContentSize(input.width, capturedHeight);
        await owner.webContents.executeJavaScript(
          "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
        );
        const image = await owner.webContents.capturePage({
          x: 0,
          y: 0,
          width: input.width,
          height: capturedHeight,
        });
        const png = image.toPNG();
        if (png.byteLength > 8 * 1024 * 1024)
          return unavailable("The preview screenshot exceeds 8 MiB.");
        return {
          _tag: "Ready",
          png: png.toString("base64"),
          width: input.width,
          contentHeight,
          capturedHeight,
          consoleMessages,
        };
      };
      return await Promise.race([
        render(),
        new Promise<HtmlPreviewResult>((resolve) => {
          timer = setTimeout(
            () => resolve(unavailable("HTML preview timed out after 15 seconds.")),
            15_000,
          );
        }),
      ]);
    } catch {
      return unavailable("The desktop could not render this HTML preview.");
    } finally {
      if (timer) clearTimeout(timer);
      if (window && !window.isDestroyed()) window.destroy();
      busy.delete(slot);
    }
  };
}

export function registerHtmlPreviewIpc(
  ipc: IpcMain,
  authorize: (event: IpcMainInvokeEvent) => void,
): void {
  const render = createHtmlPreviewRenderer();
  ipc.removeHandler(HTML_PREVIEW_CHANNEL);
  ipc.handle(HTML_PREVIEW_CHANNEL, (event, value: unknown) => {
    authorize(event);
    return render(value);
  });
}
