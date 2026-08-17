export const MAIN_RENDERER_CRASH_WINDOW_MS = 60_000;
export const MAIN_RENDERER_RELOAD_DELAYS_MS = [1_000, 2_000, 4_000] as const;

export interface MainRendererCrashRecoveryOptions {
  readonly cleanupRendererResources: () => Promise<void>;
  readonly reloadRenderer: () => Promise<void>;
  readonly showCrashScreen: () => Promise<void>;
  readonly reportError?: (operation: "cleanup" | "reload" | "crash-screen", error: unknown) => void;
  readonly now?: () => number;
}

export type MainRendererCrashRecoveryResult =
  | { readonly kind: "ignored" }
  | { readonly kind: "reload-scheduled"; readonly attempt: number; readonly delayMs: number }
  | { readonly kind: "crash-screen" };

export class MainRendererCrashRecovery {
  readonly #options: MainRendererCrashRecoveryOptions;
  readonly #now: () => number;
  #reloadAttempts: number[] = [];
  #reloadTimer: ReturnType<typeof setTimeout> | null = null;
  #handlingCrash = false;
  #halted = false;
  #disposed = false;

  constructor(options: MainRendererCrashRecoveryOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async handleCrash(): Promise<MainRendererCrashRecoveryResult> {
    if (this.#disposed || this.#handlingCrash || this.#halted) {
      return { kind: "ignored" };
    }

    this.#handlingCrash = true;
    const now = this.#now();
    this.#reloadAttempts = this.#reloadAttempts.filter(
      (attemptedAt) => now - attemptedAt < MAIN_RENDERER_CRASH_WINDOW_MS,
    );

    if (this.#reloadAttempts.length >= MAIN_RENDERER_RELOAD_DELAYS_MS.length) {
      this.#halted = true;
      const cleaned = await this.#cleanup();
      if (!cleaned || this.#disposed) {
        this.#handlingCrash = false;
        return { kind: "ignored" };
      }
      await this.#showCrashScreen();
      this.#handlingCrash = false;
      return { kind: "crash-screen" };
    }

    const attempt = this.#reloadAttempts.length + 1;
    const delayMs = MAIN_RENDERER_RELOAD_DELAYS_MS[attempt - 1]!;
    this.#reloadAttempts.push(now);
    const cleaned = await this.#cleanup();
    if (!cleaned || this.#disposed) {
      this.#handlingCrash = false;
      return { kind: "ignored" };
    }

    this.#reloadTimer = setTimeout(() => {
      this.#reloadTimer = null;
      void this.#options.reloadRenderer().then(
        () => {
          this.#handlingCrash = false;
        },
        (error: unknown) => {
          this.#options.reportError?.("reload", error);
          this.#halted = true;
          void this.#showCrashScreen().finally(() => {
            this.#handlingCrash = false;
          });
        },
      );
    }, delayMs);
    this.#reloadTimer.unref?.();

    return { kind: "reload-scheduled", attempt, delayMs };
  }

  beginManualRetry(): void {
    if (this.#disposed) return;
    if (this.#reloadTimer !== null) {
      clearTimeout(this.#reloadTimer);
      this.#reloadTimer = null;
    }
    this.#reloadAttempts = [];
    this.#handlingCrash = false;
    this.#halted = false;
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#reloadTimer !== null) {
      clearTimeout(this.#reloadTimer);
      this.#reloadTimer = null;
    }
  }

  async #cleanup(): Promise<boolean> {
    try {
      await this.#options.cleanupRendererResources();
      return true;
    } catch (error: unknown) {
      this.#options.reportError?.("cleanup", error);
      this.#halted = true;
      await this.#showCrashScreen();
      return false;
    }
  }

  async #showCrashScreen(): Promise<void> {
    if (this.#disposed) return;
    try {
      await this.#options.showCrashScreen();
    } catch (error: unknown) {
      this.#options.reportError?.("crash-screen", error);
    }
  }
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function mainRendererCrashScreenUrl(rendererUrl: string): string {
  const safeRendererUrl = escapeHtmlAttribute(rendererUrl);
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>F5 renderer recovery</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: Canvas; color: CanvasText; }
      main { width: min(34rem, calc(100vw - 3rem)); }
      h1 { font-size: 1.35rem; margin: 0 0 .75rem; }
      p { line-height: 1.5; opacity: .8; }
      a { display: inline-block; margin-top: .75rem; border-radius: .5rem; padding: .65rem 1rem; background: Highlight; color: HighlightText; text-decoration: none; font-weight: 600; }
    </style>
  </head>
  <body>
    <main>
      <h1>F5 could not recover its interface</h1>
      <p>The renderer stopped repeatedly. Background server work was left running.</p>
      <a href="${safeRendererUrl}">Reload F5</a>
    </main>
  </body>
</html>`;
  return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`;
}
