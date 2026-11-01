import { randomUUID } from "node:crypto";
import { BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron";
import {
  HTML_RENDER_MAX_PAGE_BYTES,
  HtmlPreviewRequest,
  type HtmlPreviewResult,
} from "@t3tools/contracts";
import { HTML_RENDER_MEASURE_SOURCE, htmlRenderDocument } from "@t3tools/shared/htmlRender";
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
    let debuggerAttached = false;
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
        // Agent-requested and unattended, so remote content never loads here. The reader's
        // theme comes with the request; older renderers send none and get these defaults.
        const html = htmlRenderDocument(
          input.html,
          input.theme ?? {
            appearance: input.appearance,
            variables: {
              "--background": input.appearance === "light" ? "#ffffff" : "#18181b",
              "--foreground": input.appearance === "light" ? "#18181b" : "#fafafa",
            },
          },
        );
        await owner.webContents.session.clearStorageData();
        if (owner.isDestroyed()) return unavailable("HTML preview was cancelled.");
        // Best effort: without emulation the page still gets the theme's CSS variables.
        try {
          owner.webContents.debugger.attach("1.3");
          debuggerAttached = true;
          await owner.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
            features: [{ name: "prefers-color-scheme", value: input.appearance }],
          });
        } catch {
          /* prefers-color-scheme follows the system instead. */
        }
        await owner.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        const height: unknown = await owner.webContents.executeJavaScript(
          `document.fonts.ready.then(()=>${HTML_RENDER_MEASURE_SOURCE})`,
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
      if (debuggerAttached && window && !window.isDestroyed()) {
        try {
          window.webContents.debugger.detach();
        } catch {
          /* Destroying the window detaches it anyway. */
        }
      }
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
