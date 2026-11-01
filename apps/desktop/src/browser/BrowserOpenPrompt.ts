import type { DesktopBrowserOpenChoice, DesktopBrowserOpenRequest } from "@t3tools/contracts";
import type { BrowserWindow, MessageBoxOptions } from "electron";
import type { BrowserOpenPrompt } from "./BrowserOpenAuthority";

export const BROWSER_OPEN_REQUESTED_CHANNEL = "desktop:browser-open-requested";
export const BROWSER_OPEN_SETTLED_CHANNEL = "desktop:browser-open-settled";
export const BROWSER_OPEN_CURRENT_CHANNEL = "desktop:browser-open-current";
export const BROWSER_OPEN_SHOWN_CHANNEL = "desktop:browser-open-shown";
export const BROWSER_OPEN_ANSWER_CHANNEL = "desktop:browser-open-answer";

/** Indices match the native dialog's buttons, which `BrowserOpenAuthority` interprets. */
const CHOICE_BUTTON: Record<DesktopBrowserOpenChoice, number> = {
  open: 0,
  "allow-host": 1,
  copy: 2,
  cancel: 3,
};

interface PromptWindowEffects {
  window: (profileId: string) => BrowserWindow | undefined;
  /** The in-app prompt opens the window without focusing it; the native dialog focuses it. */
  openProfile: (profileId: string) => Promise<unknown>;
  profileName: (profileId: string) => string;
}

/** The requesting profile's own window, reopened if needed; never another profile's. */
async function ownerFor(
  effects: PromptWindowEffects,
  { profileId, signal }: BrowserOpenPrompt,
): Promise<{ owner: BrowserWindow; opened: boolean } | undefined> {
  if (signal.aborted) return undefined;
  let owner = effects.window(profileId);
  const opened = !owner || owner.isDestroyed();
  if (opened) {
    await effects.openProfile(profileId);
    owner = effects.window(profileId);
  }
  return !owner || owner.isDestroyed() || signal.aborted ? undefined : { owner, opened };
}

/** Parent consent only to the requesting profile; a parent is required for macOS cancellation. */
export function createNativeBrowserOpenPrompt(
  effects: PromptWindowEffects & {
    show: (owner: BrowserWindow, options: MessageBoxOptions) => Promise<{ response: number }>;
  },
): (request: BrowserOpenPrompt) => Promise<number> {
  return async (request) => {
    const { profileId, host, url, signal } = request;
    const owner = (await ownerFor(effects, request))?.owner;
    if (!owner) return 3;
    owner.show();
    owner.focus();
    return (
      await effects.show(owner, {
        type: "question",
        title: "Open login URL",
        // Native macOS message text is bold; the URL remains in the detail.
        message: host,
        detail: `An agent or terminal in profile "${effects.profileName(profileId)}" wants to open this URL in your browser:\n\n${url.length > 300 ? url.slice(0, 299) + "…" : url}`,
        buttons: ["Open", `Allow ${host} until F5 quits`, "Copy link", "Cancel"],
        defaultId: 0,
        cancelId: 3,
        noLink: true,
        signal,
      })
    ).response;
  };
}

export interface InAppBrowserOpenPrompt {
  prompt: (request: BrowserOpenPrompt) => Promise<number>;
  current: (profileId: string) => DesktopBrowserOpenRequest | null;
  /** Re-sends the shown card with a new queue count. */
  waitingChanged: (profileId: string, waiting: number) => void;
  acknowledge: (profileId: string, requestId: unknown) => void;
  /** Throws, leaving the request pending, unless every check passes. */
  answer: (profileId: string, requestId: unknown, choice: unknown, trusted: unknown) => void;
}

/**
 * Shows the decision as a card in the profile's window. Main stays the authority: the renderer
 * only reports a choice, and could already open any http(s) URL through `desktop:open-external`.
 * Falls back to the native dialog when no card acknowledges the request.
 */
export function createInAppBrowserOpenPrompt(
  effects: PromptWindowEffects & {
    /**
     * Draws attention without stealing focus, so typing elsewhere cannot answer. Returns a
     * disposer, called when the request settles.
     */
    attention: (profileId: string, host: string) => () => void;
    native: (request: BrowserOpenPrompt) => Promise<number>;
    acknowledgeTimeoutMs?: number;
    /** A window that is still loading needs time to load, hydrate and mount the card. */
    coldAcknowledgeTimeoutMs?: number;
  },
): InAppBrowserOpenPrompt {
  const active = new Map<
    string,
    {
      request: DesktopBrowserOpenRequest;
      acknowledged: boolean;
      send: () => void;
      finish: (button: number) => void;
    }
  >();
  const pending = (profileId: string, requestId: unknown) => {
    const entry = active.get(profileId);
    if (!entry || typeof requestId !== "string" || entry.request.requestId !== requestId)
      throw new Error("This browser open request is no longer pending.");
    return entry;
  };
  return {
    prompt: async (request) => {
      // Read before anything is shown: only a window the user is already in skips attention.
      const before = effects.window(request.profileId);
      const wasFocused = !!before && !before.isDestroyed() && before.isFocused();
      const resolved = await ownerFor(effects, request);
      // The authority aborts on timeout or cancel; that may happen while the window opens.
      if (!resolved || request.signal.aborted) return 3;
      const { owner, opened } = resolved;
      // `show()` focuses and activates F5; a minimized window stays minimized.
      if (!owner.isVisible() && !owner.isMinimized()) owner.showInactive();
      const dismissAttention = wasFocused
        ? undefined
        : effects.attention(request.profileId, request.host);
      const contents = owner.webContents;
      const card: DesktopBrowserOpenRequest = {
        requestId: request.requestId,
        host: request.host,
        url: request.url,
        profileName: effects.profileName(request.profileId),
        expiresAtMs: request.expiresAtMs,
        waiting: request.waiting(),
      };
      const FALLBACK = -1;
      const button = await new Promise<number>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (value: number) => {
          if (active.get(request.profileId) !== entry) return;
          active.delete(request.profileId);
          clearTimeout(timer);
          dismissAttention?.();
          request.signal.removeEventListener("abort", aborted);
          if (!contents.isDestroyed()) {
            contents.removeListener("render-process-gone", crashed);
            contents.removeListener("destroyed", closed);
            contents.send(BROWSER_OPEN_SETTLED_CHANNEL, card.requestId);
          }
          resolve(value);
        };
        const entry = {
          request: card,
          acknowledged: false,
          send: () => {
            if (!contents.isDestroyed())
              contents.send(BROWSER_OPEN_REQUESTED_CHANNEL, entry.request);
          },
          finish,
        };
        const aborted = () => finish(3);
        // A crash leaves a window for the native dialog; closing the window means Cancel and
        // must not reopen it.
        const crashed = () => finish(FALLBACK);
        const closed = () => finish(3);
        active.set(request.profileId, entry);
        request.signal.addEventListener("abort", aborted, { once: true });
        contents.once("render-process-gone", crashed);
        contents.once("destroyed", closed);
        const cold = opened || contents.isLoading();
        timer = setTimeout(
          () => {
            if (!entry.acknowledged) finish(FALLBACK);
          },
          cold
            ? (effects.coldAcknowledgeTimeoutMs ?? 15_000)
            : (effects.acknowledgeTimeoutMs ?? 3000),
        );
        // A window that is still loading drops this; its card asks `current()` once mounted.
        entry.send();
      });
      if (button !== FALLBACK) return button;
      return request.signal.aborted ? 3 : effects.native(request);
    },
    current: (profileId) => active.get(profileId)?.request ?? null,
    waitingChanged: (profileId, waiting) => {
      const entry = active.get(profileId);
      if (!entry || entry.request.waiting === waiting) return;
      entry.request = { ...entry.request, waiting };
      entry.send();
    },
    acknowledge: (profileId, requestId) => {
      pending(profileId, requestId).acknowledged = true;
    },
    answer: (profileId, requestId, choice, trusted) => {
      const entry = pending(profileId, requestId);
      if (typeof choice !== "string" || !Object.hasOwn(CHOICE_BUTTON, choice))
        throw new Error("Invalid browser open choice.");
      if (choice !== "cancel" && trusted !== true)
        throw new Error("Opening a link requires a trusted user gesture.");
      entry.finish(CHOICE_BUTTON[choice as DesktopBrowserOpenChoice]);
    },
  };
}
