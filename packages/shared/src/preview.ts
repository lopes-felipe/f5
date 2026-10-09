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

const LOOPBACK_PREFIX_PATTERN =
  /^(?:localhost|(?:[a-z0-9-]+\.)+localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::|\/|$)/i;

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || host === "[::1]";
}

/** Loopback for preview navigation: the fixed loopback hosts plus any `*.localhost` name. */
export function isLoopbackPreviewHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return isLoopbackHost(normalized) || normalized.endsWith(".localhost");
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

/** Sites a preview tab may visit in addition to loopback. */
export interface PreviewNavigationPolicy {
  readonly externalHosts: ReadonlyArray<string>;
}

export type PreviewHostPattern =
  | { readonly kind: "exact"; readonly scheme: "https" | "http"; readonly host: string }
  | { readonly kind: "subdomains"; readonly scheme: "https"; readonly domain: string }
  | { readonly kind: "any"; readonly scheme: "https" };

export type PreviewHostPatternParseResult =
  | { readonly ok: true; readonly pattern: PreviewHostPattern }
  | { readonly ok: false; readonly error: string };

const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export function isIpLiteralHost(host: string): boolean {
  return IPV4_PATTERN.test(host) || host.includes(":") || host.startsWith("[");
}

function normalizePatternHost(raw: string): string | null {
  if (raw.length === 0 || /[/?#@\s]/.test(raw)) return null;
  // `new URL` drops default ports, so reject any port syntax up front. Bracketed
  // IPv6 literals are the only hosts that may contain a colon.
  if (!/^\[[^\]]+\]$/.test(raw) && raw.includes(":")) return null;
  try {
    const parsed = new URL(`https://${raw}`);
    // Ports are not part of the grammar; refuse them rather than silently ignore.
    if (parsed.port !== "" || parsed.username !== "" || parsed.password !== "") return null;
    return parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/**
 * Parse one allowlist entry. Grammar: `host` (https only), `*.domain` (https
 * subdomains only), `*` (any DNS host, https), `http://host` (exact host over
 * plain http). Ports, paths and credentials are rejected.
 */
export function parsePreviewHostPattern(rawPattern: string): PreviewHostPatternParseResult {
  const pattern = rawPattern.trim();
  if (pattern.length === 0) return { ok: false, error: "Empty entry." };
  if (pattern === "*") return { ok: true, pattern: { kind: "any", scheme: "https" } };
  if (pattern.toLowerCase().startsWith("http://")) {
    const host = normalizePatternHost(pattern.slice("http://".length));
    if (!host || host.includes("*")) {
      return { ok: false, error: `"${pattern}" must be http:// followed by one exact host.` };
    }
    return { ok: true, pattern: { kind: "exact", scheme: "http", host } };
  }
  if (pattern.includes("://")) {
    return {
      ok: false,
      error: `"${pattern}": only http:// may be written explicitly; plain hosts mean https.`,
    };
  }
  if (pattern.startsWith("*.")) {
    const domain = normalizePatternHost(pattern.slice(2));
    if (!domain || domain.includes("*") || isIpLiteralHost(domain)) {
      return { ok: false, error: `"${pattern}" must be *. followed by a DNS domain.` };
    }
    return { ok: true, pattern: { kind: "subdomains", scheme: "https", domain } };
  }
  const host = normalizePatternHost(pattern);
  if (!host || host.includes("*")) {
    return { ok: false, error: `"${pattern}" is not a valid host.` };
  }
  return { ok: true, pattern: { kind: "exact", scheme: "https", host } };
}

/** Validation errors for a whole allowlist, in input order. */
export function validatePreviewHostPatterns(patterns: ReadonlyArray<string>): string[] {
  return patterns.flatMap((pattern) => {
    const parsed = parsePreviewHostPattern(pattern);
    return parsed.ok ? [] : [parsed.error];
  });
}

function patternMatches(pattern: PreviewHostPattern, scheme: string, host: string): boolean {
  if (scheme !== pattern.scheme) return false;
  switch (pattern.kind) {
    case "exact":
      return host === pattern.host;
    case "subdomains":
      return !isIpLiteralHost(host) && host.endsWith(`.${pattern.domain}`);
    case "any":
      return !isIpLiteralHost(host);
  }
}

/**
 * True when `rawUrl` is loopback or matches the allowlist. Credentials and
 * non-http(s) protocols never match.
 */
export function matchesPreviewHostPolicy(
  rawUrl: string,
  policy: PreviewNavigationPolicy | undefined,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (isLoopbackPreviewHost(host)) return true;
  const scheme = parsed.protocol.slice(0, -1);
  for (const entry of policy?.externalHosts ?? []) {
    const result = parsePreviewHostPattern(entry);
    if (result.ok && patternMatches(result.pattern, scheme, host)) return true;
  }
  return false;
}

export function normalizePreviewUrl(rawUrl: string, policy?: PreviewNavigationPolicy): string {
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
  if (parsed.username !== "" || parsed.password !== "") {
    throw new PreviewUrlNormalizationError(rawUrl, "URLs with credentials are not allowed");
  }
  if (!matchesPreviewHostPolicy(parsed.href, policy)) {
    throw new PreviewUrlNormalizationError(
      rawUrl,
      (policy?.externalHosts.length ?? 0) > 0
        ? `${parsed.protocol}//${parsed.hostname} is not in the allowed sites list`
        : `non-loopback host ${parsed.hostname}`,
    );
  }

  return parsed.href;
}

const TAGGED_AUTOMATION_ERROR_PATTERN = /\[f5:(PreviewAutomation[A-Za-z]+Error)\] ([\s\S]*)$/;

/**
 * Electron IPC flattens thrown errors to their message, so the desktop process embeds the
 * automation error tag in the message and the renderer recovers it before replying.
 */
export function encodeTaggedAutomationErrorMessage(tag: string, message: string): string {
  return `[f5:${tag}] ${message}`;
}

export function decodeTaggedAutomationErrorMessage(
  message: string,
): { readonly tag: string; readonly message: string } | null {
  const match = TAGGED_AUTOMATION_ERROR_PATTERN.exec(message);
  return match ? { tag: match[1]!, message: match[2]! } : null;
}
