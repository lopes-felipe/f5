import { randomUUID } from "node:crypto";
import { BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron";
import {
  HTML_PREVIEW_RENDER_DEADLINE_MS,
  HTML_RENDER_MAX_PAGE_BYTES,
  HtmlPreviewRequest,
  type HtmlPreviewResult,
} from "@t3tools/contracts";
import { HTML_RENDER_MEASURE_SOURCE, htmlRenderDocument } from "@t3tools/shared/htmlRender";
import { Schema } from "effect";

export const HTML_PREVIEW_CHANNEL = "desktop:html-preview";
/** Color-scheme emulation is best effort; the page still gets the theme's CSS variables. */
const EMULATION_TIMEOUT_MS = 1_000;
const unavailable = (message: string): HtmlPreviewResult => ({ _tag: "Unavailable", message });

/**
 * Error text for the desktop log: one line, and without data: URLs, since
 * Electron's load errors quote the URL and so the start of the agent's page.
 */
export const logSafeErrorText = (error: unknown): string =>
  (error instanceof Error ? error.message : "unknown")
    .replace(/data:\S*/g, "data:<omitted>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

const TIMED_OUT = Symbol("timed out");
/** Settles with the promise, or with `TIMED_OUT` after `ms`; a late rejection is swallowed. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Both page-side waits fall back to a timer: font loading can stall, and a hidden
// offscreen widget may never receive the BeginFrames that drive rAF.
export const MEASURE_SCRIPT = `Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,2000))]).then(()=>${HTML_RENDER_MEASURE_SOURCE})`;
export const SETTLE_SCRIPT =
  "new Promise(resolve=>{const t=setTimeout(resolve,500);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(t);resolve()}))})";

type Stage =
  | "creating window"
  | "clearing storage"
  | "starting renderer"
  | "emulating color scheme"
  | "loading page"
  | "measuring"
  | "settling frames"
  | "capturing"
  | "encoding";

export function createHtmlPreviewRenderer(log?: (message: string) => void) {
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
    let stage: Stage = "creating window";
    const startedAt = Date.now();
    const report = (outcome: string) =>
      log?.(`html preview ${outcome} stage="${stage}" ms=${Date.now() - startedAt}`);
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
        stage = "clearing storage";
        await owner.webContents.session.clearStorageData();
        if (owner.isDestroyed()) return unavailable("HTML preview was cancelled.");
        // A new window has no renderer until it navigates, and Blink answers
        // setEmulatedMedia, so the command would wait for a navigation that only
        // starts after it settles. Load a blank page first so a renderer exists.
        stage = "starting renderer";
        await owner.loadURL("about:blank");
        // Best effort, and skipped (with a log line) when it fails or never answers;
        // prefers-color-scheme then follows the system.
        let emulationSkipped = false;
        const emulate = async () => {
          if (emulationSkipped) return;
          stage = "emulating color scheme";
          try {
            if (!debuggerAttached) {
              owner.webContents.debugger.attach("1.3");
              debuggerAttached = true;
            }
            const answer = await withTimeout(
              owner.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
                features: [{ name: "prefers-color-scheme", value: input.appearance }],
              }),
              EMULATION_TIMEOUT_MS,
            );
            if (answer === TIMED_OUT) throw new Error("no answer");
          } catch (error) {
            emulationSkipped = true;
            report(`emulation skipped error="${logSafeErrorText(error)}"`);
          }
        };
        await emulate();
        stage = "loading page";
        await owner.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        // Again on the live document, in case the emulation did not carry over
        // the navigation; the page's own load-time media checks saw the first one.
        await emulate();
        stage = "measuring";
        const height: unknown = await owner.webContents.executeJavaScript(MEASURE_SCRIPT);
        const contentHeight =
          typeof height === "number" && Number.isFinite(height)
            ? Math.max(1, Math.min(100_000, Math.ceil(height)))
            : 800;
        const capturedHeight = Math.min(2000, contentHeight);
        owner.setContentSize(input.width, capturedHeight);
        stage = "settling frames";
        await owner.webContents.executeJavaScript(SETTLE_SCRIPT);
        stage = "capturing";
        const image = await owner.webContents.capturePage({
          x: 0,
          y: 0,
          width: input.width,
          height: capturedHeight,
        });
        stage = "encoding";
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
          timer = setTimeout(() => {
            report("timed out");
            resolve(
              unavailable(
                `HTML preview timed out while ${stage} after ${HTML_PREVIEW_RENDER_DEADLINE_MS / 1000} seconds.`,
              ),
            );
          }, HTML_PREVIEW_RENDER_DEADLINE_MS);
        }),
      ]);
    } catch (error) {
      report(`failed error="${logSafeErrorText(error)}"`);
      return unavailable(`The desktop could not render this HTML preview (${stage}).`);
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
  log?: (message: string) => void,
): void {
  const render = createHtmlPreviewRenderer(log);
  ipc.removeHandler(HTML_PREVIEW_CHANNEL);
  ipc.handle(HTML_PREVIEW_CHANNEL, (event, value: unknown) => {
    authorize(event);
    return render(value);
  });
}
