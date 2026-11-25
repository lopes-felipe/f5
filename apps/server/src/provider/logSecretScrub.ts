/**
 * Redacts credentials from text written to provider event logs.
 *
 * Only formats that are almost never anything but a secret are matched, so tool output,
 * diffs and code stay intact for the tools that repair transcripts from these logs.
 * Generic `key=value` or `password: …` text is deliberately left alone. A secret split
 * across streamed deltas is not caught.
 */
export const REDACTED = "[REDACTED]";

const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@:]+:[^\s/?#@]+@/gi;
const TOKEN_PATTERNS: ReadonlyArray<RegExp> = [
  // OpenAI and Anthropic keys (sk-…, sk-proj-…, sk-ant-…); real keys always hold a digit.
  /\bsk-(?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{20,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];
// The digit lookahead keeps prose such as "Basic authentication" intact.
const AUTHORIZATION_CREDENTIAL =
  /\b([Bb]earer|[Bb]asic)(\s+)(?=[A-Za-z._~+/=-]*\d)[A-Za-z0-9._~+/=-]{16,}/g;

export function scrubSecretsInText(text: string): string {
  let result = text.replace(PRIVATE_KEY_BLOCK, REDACTED).replace(URL_CREDENTIALS, `$1${REDACTED}@`);
  for (const pattern of TOKEN_PATTERNS) result = result.replace(pattern, REDACTED);
  return result.replace(AUTHORIZATION_CREDENTIAL, `$1$2${REDACTED}`);
}

const IDENTIFIER_KEY = /(?:^|_)id$|Id$/;

/**
 * Whether a string field must reach the log byte for byte: thinking signatures, the
 * encrypted payload of redacted thinking, and identifiers. Transcript repair replays them.
 */
export function isScrubExemptField(holder: unknown, key: string): boolean {
  if (key === "signature" || IDENTIFIER_KEY.test(key)) return true;
  return (
    key === "data" &&
    typeof holder === "object" &&
    holder !== null &&
    (holder as { type?: unknown }).type === "redacted_thinking"
  );
}
