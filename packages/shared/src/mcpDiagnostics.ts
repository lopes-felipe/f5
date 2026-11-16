import type { McpProjectServersConfig } from "@t3tools/contracts";

/** Covers header names and common bare, snake_case, and camelCase credential fields. */
export function isMcpCredentialKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return /authorization|secret$|(?:^|[-_])(?:token|key|secret|password|cookie)$/i.test(normalized);
}

/** Supplemental value scrubbing; transformed credentials cannot be guaranteed to match. */
export function createMcpDiagnosticsSanitizer(
  servers: McpProjectServersConfig = {},
  additionalValues: ReadonlyArray<string> = [],
) {
  const values = [
    ...new Set(
      [
        ...Object.values(servers).flatMap((server) => [
          ...Object.values(server.env ?? {}),
          ...Object.values(server.headers ?? {}),
        ]),
        ...additionalValues,
      ].filter((value) => value.length >= 8),
    ),
  ].sort((a, b) => b.length - a.length);
  const text = (value: string): string => {
    let result = value;
    for (const secret of values) result = result.split(secret).join("[redacted]");
    result = result.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        if (!url.hostname) return "[redacted URL]";
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[redacted URL]";
      }
    });
    return result
      .replace(
        /\b(authorization|(?:set-)?cookie)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/gi,
        "$1: [redacted]",
      )
      .replace(
        /\b([\w-]+)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|(?:Bearer\s+)?[^\s,;}]+)/gi,
        (match, key: string) => (isMcpCredentialKey(key) ? `${key}: [redacted]` : match),
      )
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      .slice(0, 8192);
  };
  const json = (value: unknown, depth = 0): unknown => {
    if (depth > 32) return "[omitted: nesting depth]";
    if (typeof value === "string") return text(value);
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (Array.isArray(value)) return value.slice(0, 1000).map((entry) => json(entry, depth + 1));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .slice(0, 1000)
          .map(([key, child]) => [
            key,
            isMcpCredentialKey(key) ? "[redacted]" : json(child, depth + 1),
          ]),
      );
    return null;
  };
  return { text, json };
}

export function sanitizeMcpReconnectResult(
  result: import("@t3tools/contracts").McpReconnectServerResult,
  servers: McpProjectServersConfig,
  additionalValues: ReadonlyArray<string> = [],
) {
  const sanitizer = createMcpDiagnosticsSanitizer(servers, additionalValues);
  return {
    ...result,
    failures: result.failures
      .slice(0, 1000)
      .map((failure) => ({ ...failure, message: sanitizer.text(failure.message).slice(0, 2000) })),
    ...(result.sessions
      ? {
          sessions: result.sessions.slice(0, 1000).map((session) => ({
            ...session,
            result: {
              ...session.result,
              servers: session.result.servers.slice(0, 1000).map((server) => ({
                ...server,
                ...(server.error ? { error: sanitizer.text(server.error).slice(0, 2000) } : {}),
              })),
              errors: session.result.errors.slice(0, 1000).map((error) => ({
                ...error,
                message: sanitizer.text(error.message).slice(0, 2000),
              })),
            },
          })),
        }
      : {}),
  };
}
