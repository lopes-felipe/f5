import type { ProviderRuntimeEvent } from "@t3tools/contracts";

/** Scrub credentials before provider diagnostics reach logs or durable turn state. */
export function redactProviderFailureText(value: string): string {
  return value
    .replace(/\bhttps?:\/\/[^\s<>"']+/giu, (candidate) => {
      try {
        const url = new URL(candidate);
        let changed = !!(url.username || url.password);
        if (url.username) url.username = "[REDACTED]";
        if (url.password) url.password = "[REDACTED]";
        for (const key of url.searchParams.keys())
          if (/(?:token|key|authorization|credential|password|secret)$/iu.test(key)) {
            url.searchParams.set(key, "[REDACTED]");
            changed = true;
          }
        return changed ? url.toString() : candidate;
      } catch {
        return candidate;
      }
    })
    .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/giu, "$1 [REDACTED]")
    .replace(
      /(["'][\w-]*(?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)["']\s*:\s*["'])[^"']*(["'])/giu,
      "$1[REDACTED]$2",
    )
    .replace(
      /((?<![\w-])[\w-]*(?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1[REDACTED]",
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9][A-Za-z0-9_-]{7,}|ghp_[A-Za-z0-9]+|xox[a-zA-Z]-[A-Za-z0-9-]+)\b/gu,
      "[REDACTED]",
    );
}

function redactFailureDetail(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactProviderFailureText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 16) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((entry) => redactFailureDetail(entry, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      /(?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)$/iu.test(key)
        ? "[REDACTED]"
        : redactFailureDetail(entry, depth + 1),
    ]),
  );
}

/** Keep ordinary conversation and tool content outside the failure redaction boundary. */
export function redactProviderRuntimeFailure(event: ProviderRuntimeEvent): ProviderRuntimeEvent {
  // Legacy adapters may still emit terminal notifications without a canonical payload.
  if (!event.payload) return event;
  switch (event.type) {
    case "runtime.error":
    case "runtime.warning":
      return {
        ...event,
        payload: {
          ...event.payload,
          message: redactProviderFailureText(event.payload.message),
          ...(event.payload.detail !== undefined
            ? { detail: redactFailureDetail(event.payload.detail) }
            : {}),
        },
      };
    case "turn.completed":
      return event.payload.errorMessage === undefined
        ? event
        : {
            ...event,
            payload: {
              ...event.payload,
              errorMessage: redactProviderFailureText(event.payload.errorMessage),
            },
          };
    default:
      return event;
  }
}
