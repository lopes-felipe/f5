/** Longest Claude API error text shown on a failed turn. */
export const MAX_CLAUDE_API_ERROR_TEXT_LENGTH = 500;

const SECRET_KEYS = "access[_-]?token|api[_-]?key|authorization|credential|password|secret|token";

function redactUrl(match: string): string {
  const trailing = /[),.;:!?\]]+$/u.exec(match)?.[0] ?? "";
  const raw = trailing ? match.slice(0, -trailing.length) : match;
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${url.toString()}${trailing}`;
  } catch {
    return "[REDACTED_URL]";
  }
}

// Keep tab, line feed and carriage return; blank out other control characters.
function replaceControlCharacters(value: string): string {
  let sanitized = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    sanitized +=
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
        ? " "
        : character;
  }
  return sanitized;
}

function redactApiErrorText(value: string): string {
  return replaceControlCharacters(value)
    .replace(/\bhttps?:\/\/[^\s<>"']+/giu, redactUrl)
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, "$1 [REDACTED]")
    .replace(
      new RegExp(`(["'](?:${SECRET_KEYS})["']\\s*:\\s*["'])[^"']*(["'])`, "giu"),
      "$1[REDACTED]$2",
    )
    .replace(
      new RegExp(`(\\b(?:${SECRET_KEYS})\\b\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,;]+)`, "giu"),
      "$1[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED]")
    .trim();
}

/**
 * A Claude turn that ends with terminal_reason `api_error` reports the API's
 * own message as result text ("API Error: ..."). Show it, redacted and capped,
 * instead of a generic failure.
 */
export function claudeApiErrorText(result: {
  readonly subtype: string;
  readonly terminal_reason?: string | null | undefined;
  readonly result?: string | undefined;
}): string | undefined {
  if (result.subtype !== "success" || result.terminal_reason !== "api_error") return undefined;
  const text = result.result?.trim() ?? "";
  if (!text.startsWith("API Error:")) return undefined;
  const redacted = redactApiErrorText(text);
  if (redacted.length <= MAX_CLAUDE_API_ERROR_TEXT_LENGTH) return redacted;
  let end = MAX_CLAUDE_API_ERROR_TEXT_LENGTH - 1;
  const last = redacted.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${redacted.slice(0, end)}…`;
}
