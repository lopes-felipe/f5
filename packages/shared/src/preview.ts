const TAB_ID_PREFIX = "tab_";
let nextPreviewTabSequence = 0;

export function newPreviewTabId(): string {
  nextPreviewTabSequence += 1;
  return `${TAB_ID_PREFIX}${nextPreviewTabSequence.toString(36)}`;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

export const LSOF_LOCAL_HOST_TOKENS: ReadonlySet<string> = new Set([
  ...LOOPBACK_HOSTS,
  "*",
  "[::]",
  "[::1]",
]);

const LOOPBACK_PREFIX_PATTERN = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::|\/|$)/i;

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || host === "[::1]";
}

export function isPreviewableUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

export class PreviewUrlNormalizationError extends Error {
  readonly rawUrl: string;
  readonly detail: string;

  constructor(rawUrl: string, detail: string) {
    super(`Invalid preview URL: ${rawUrl} (${detail})`);
    this.name = "PreviewUrlNormalizationError";
    this.rawUrl = rawUrl;
    this.detail = detail;
  }
}

export function normalizePreviewUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    throw new PreviewUrlNormalizationError(rawUrl, "empty");
  }

  const useHttp = LOOPBACK_PREFIX_PATTERN.test(trimmed);
  const candidate = trimmed.includes("://")
    ? trimmed
    : `${useHttp ? "http" : "https"}://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch (cause) {
    throw new PreviewUrlNormalizationError(
      rawUrl,
      cause instanceof Error ? cause.message : "unparseable",
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PreviewUrlNormalizationError(rawUrl, `unsupported protocol ${parsed.protocol}`);
  }
  if (!isLoopbackHost(parsed.hostname)) {
    throw new PreviewUrlNormalizationError(rawUrl, `non-loopback host ${parsed.hostname}`);
  }

  return parsed.href;
}
