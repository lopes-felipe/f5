import {
  PROMPT_LINK_DEV_SCHEME,
  PROMPT_LINK_SCHEME,
  promptLinkAppPath,
} from "@t3tools/shared/promptLinks";

/** Development builds register their own scheme so they never take links meant for F5. */
export function promptLinkSchemeFor(isDevelopment: boolean): string {
  return isDevelopment ? PROMPT_LINK_DEV_SCHEME : PROMPT_LINK_SCHEME;
}

/**
 * The arguments `setAsDefaultProtocolClient` needs. An unpackaged Electron is launched with the
 * app's entry script, which the OS must pass back or the link would open a bare Electron.
 */
export function protocolClientRegistration(input: {
  readonly defaultApp: boolean;
  readonly execPath: string;
  readonly entryScript: string | undefined;
}): { readonly path: string; readonly args: readonly string[] } | null {
  if (!input.defaultApp) return null;
  return input.entryScript ? { path: input.execPath, args: [input.entryScript] } : null;
}

/**
 * The entry script an unpackaged Electron was started with: its first argument that is not a
 * switch. The dev launcher puts `--t3code-dev-root=…` ahead of it.
 */
export function entryScriptInArgv(argv: readonly string[]): string | undefined {
  return argv.slice(1).find((arg) => !arg.startsWith("-"));
}

/** A prompt link Windows and Linux pass on the command line of a second launch. */
export function promptLinkInArgv(argv: readonly string[], scheme: string): string | null {
  return argv.find((arg) => arg.toLowerCase().startsWith(`${scheme}:`)) ?? null;
}

const MAX_PENDING_LINKS = 10;

/**
 * Prompt links wait here until a renderer takes them, so a link that arrives before the window
 * has loaded (a cold start opened by the link) is not lost. Each link records the profile it
 * was sent to, so a window of another profile that loads or reloads meanwhile cannot take it.
 */
export class PromptLinkInbox {
  #pending: Array<{ readonly url: string; readonly profileId: string | null }> = [];

  constructor(private readonly scheme: string) {}

  /**
   * Queues a link this build opens for `profileId`, or for whichever profile takes it first
   * when null. Returns false for anything that is not a link this build opens.
   */
  receive(url: string, profileId: string | null = null): boolean {
    if (!url.toLowerCase().startsWith(`${this.scheme}:`)) return false;
    if (promptLinkAppPath(url) === null) return false;
    this.#pending.push({ url, profileId });
    if (this.#pending.length > MAX_PENDING_LINKS) this.#pending.shift();
    return true;
  }

  /** Removes and returns the links `profileId` may open; others stay queued. */
  take(profileId?: string): readonly string[] {
    const taken: string[] = [];
    this.#pending = this.#pending.filter((link) => {
      if (profileId !== undefined && link.profileId !== null && link.profileId !== profileId)
        return true;
      taken.push(link.url);
      return false;
    });
    return taken;
  }
}
