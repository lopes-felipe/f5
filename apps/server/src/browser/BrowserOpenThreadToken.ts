import { randomBytes } from "node:crypto";
import { BROWSER_OPEN_TOKEN_ENV, browserOpenEnabled } from "./BrowserOpenLauncher";

/*
 * Names the thread whose agent or terminal ran the browser launcher. It is a capability, not
 * proof of identity: any process that can read a thread's environment can present it. That
 * is acceptable because it only lets a request skip the prompt for a thread whose user
 * already chose full access, and the rate limit and HTTP-only checks still apply.
 */
export { BROWSER_OPEN_TOKEN_ENV };

const tokenByThread = new Map<string, string>();
const threadByToken = new Map<string, string>();

/** Stable for this server process, so restarted sessions of a thread share one token. */
export function browserOpenTokenFor(threadId: string): string {
  const existing = tokenByThread.get(threadId);
  if (existing) return existing;
  const token = randomBytes(24).toString("base64url");
  tokenByThread.set(threadId, token);
  threadByToken.set(token, threadId);
  return token;
}

export function browserOpenThreadFor(token: unknown): string | undefined {
  return typeof token === "string" ? threadByToken.get(token) : undefined;
}

/**
 * Sets the thread's token when the launcher is installed. Any inherited token is dropped
 * first, so a process never presents another thread's (or another F5's) token.
 */
export function withBrowserOpenThreadToken(
  environment: NodeJS.ProcessEnv,
  threadId: string | undefined,
  enabled = browserOpenEnabled(),
): NodeJS.ProcessEnv {
  const next = { ...environment };
  for (const key of Object.keys(next))
    if (key.toUpperCase() === BROWSER_OPEN_TOKEN_ENV) delete next[key];
  if (enabled && threadId) next[BROWSER_OPEN_TOKEN_ENV] = browserOpenTokenFor(threadId);
  return next;
}
