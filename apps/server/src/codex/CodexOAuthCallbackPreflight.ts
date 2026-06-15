import net from "node:net";

const DEFAULT_PRECHECK_TIMEOUT_MS = 1_500;
const DEFAULT_PRECHECK_RETRY_INTERVAL_MS = 100;

export class CodexOAuthCallbackPreflightError extends Error {
  readonly callbackUrl: string;

  constructor(callbackUrl: string) {
    super(
      `OAuth callback listener is not reachable at ${callbackUrl}. Codex returned an authorization URL, but no local process is listening for the browser redirect. Restart the login or configure a different OAuth callback port or URL.`,
    );
    this.name = "CodexOAuthCallbackPreflightError";
    this.callbackUrl = callbackUrl;
  }
}

export class CodexOAuthCallbackConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexOAuthCallbackConfigError";
  }
}

export interface CodexOAuthCallbackPreflightInput {
  readonly authorizationUrl: string;
  readonly mcpOAuthCallbackPort?: number;
  readonly mcpOAuthCallbackUrl?: string;
  readonly timeoutMs?: number;
  readonly retryIntervalMs?: number;
}

function parseUrl(value: string | undefined): URL | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function readRedirectUri(authorizationUrl: string): string | undefined {
  const parsed = parseUrl(authorizationUrl);
  return parsed?.searchParams.get("redirect_uri") ?? undefined;
}

function readConfiguredCallbackUrl(input: {
  readonly mcpOAuthCallbackPort?: number;
  readonly mcpOAuthCallbackUrl?: string;
}): string | undefined {
  if (input.mcpOAuthCallbackUrl?.trim()) {
    return input.mcpOAuthCallbackUrl.trim();
  }
  return input.mcpOAuthCallbackPort ? `http://127.0.0.1:${input.mcpOAuthCallbackPort}/` : undefined;
}

export function readCodexOAuthCallbackUrl(
  input: CodexOAuthCallbackPreflightInput,
): URL | undefined {
  return (
    parseUrl(readRedirectUri(input.authorizationUrl)) ?? parseUrl(readConfiguredCallbackUrl(input))
  );
}

export function validateCodexOAuthCallbackConfig(input: {
  readonly mcpOAuthCallbackPort?: number;
  readonly mcpOAuthCallbackUrl?: string;
}): void {
  const configuredUrl = input.mcpOAuthCallbackUrl?.trim();
  if (!configuredUrl) {
    return;
  }

  const parsed = parseUrl(configuredUrl);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new CodexOAuthCallbackConfigError(
      "OAuth callback URL must be a valid HTTP or HTTPS URL.",
    );
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return (
    normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(normalized)
  );
}

function readPort(url: URL): number | undefined {
  if (url.port) {
    return Number.parseInt(url.port, 10);
  }
  if (url.protocol === "http:") {
    return 80;
  }
  if (url.protocol === "https:") {
    return 443;
  }
  return undefined;
}

function hostsForLoopbackPreflight(hostname: string): string[] {
  const normalized = normalizeHostname(hostname);
  return normalized === "localhost" ? ["127.0.0.1", "::1"] : [normalized];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function canConnectToPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    const settle = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      settle(true);
    });
    socket.once("error", () => {
      settle(false);
    });
    socket.once("timeout", () => {
      settle(false);
    });
  });
}

async function canConnectToAnyLoopbackHost(
  hosts: ReadonlyArray<string>,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  for (const host of hosts) {
    if (await canConnectToPort(host, port, timeoutMs)) {
      return true;
    }
  }
  return false;
}

export async function preflightCodexOAuthCallback(
  input: CodexOAuthCallbackPreflightInput,
): Promise<void> {
  const callbackUrl = readCodexOAuthCallbackUrl(input);
  if (!callbackUrl || !isLoopbackHostname(callbackUrl.hostname)) {
    return;
  }

  const port = readPort(callbackUrl);
  if (!port) {
    return;
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_PRECHECK_TIMEOUT_MS;
  const retryIntervalMs = input.retryIntervalMs ?? DEFAULT_PRECHECK_RETRY_INTERVAL_MS;
  const deadlineMs = Date.now() + timeoutMs;
  const hosts = hostsForLoopbackPreflight(callbackUrl.hostname);

  do {
    const remainingMs = Math.max(1, deadlineMs - Date.now());
    const connectTimeoutMs = Math.min(retryIntervalMs, remainingMs);
    if (await canConnectToAnyLoopbackHost(hosts, port, connectTimeoutMs)) {
      return;
    }
    await delay(retryIntervalMs);
  } while (Date.now() < deadlineMs);

  throw new CodexOAuthCallbackPreflightError(callbackUrl.toString());
}
