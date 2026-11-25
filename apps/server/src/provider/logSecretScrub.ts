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
// An explicit Authorization header. After a scheme the credential is redacted whatever its
// length or alphabet; a bare value must look like a token, so prose after "Authorization:"
// survives. Shell and template placeholders ($TOKEN, ${{ … }}, <token>) stay readable.
const AUTHORIZATION_HEADER_WITH_SCHEME =
  /(\bauthorization["']?\s*[:=]\s*["']?(?:bearer|basic|token|digest)\s+)(?![$<{[])[^\s"'`,;]+/gi;
const AUTHORIZATION_HEADER_BARE =
  /(\bauthorization["']?\s*[:=]\s*["']?)(?!(?:bearer|basic|token|digest)\s)(?![$<{[])[A-Za-z0-9._~+/=-]{12,}/gi;
// A scheme in running text. The digit and length rules keep prose such as
// "Basic authentication" or "Bearer tokens expire" intact.
const AUTHORIZATION_CREDENTIAL =
  /\b(bearer|basic)(\s+)(?=[A-Za-z._~+/=-]*\d)[A-Za-z0-9._~+/=-]{16,}/gi;
// Cheap gate: most strings (token deltas, ordinary output) hold none of these markers.
const MAY_HOLD_SECRET =
  /sk-|gh[pousr]_|github_pat_|glpat-|xox[abprs]-|akia|aiza|eyj|:\/\/|-----begin|bearer|basic|authorization/i;

export function scrubSecretsInText(text: string): string {
  if (!MAY_HOLD_SECRET.test(text)) return text;
  let result = text.replace(PRIVATE_KEY_BLOCK, REDACTED).replace(URL_CREDENTIALS, `$1${REDACTED}@`);
  for (const pattern of TOKEN_PATTERNS) result = result.replace(pattern, REDACTED);
  return result
    .replace(AUTHORIZATION_HEADER_WITH_SCHEME, `$1${REDACTED}`)
    .replace(AUTHORIZATION_HEADER_BARE, `$1${REDACTED}`)
    .replace(AUTHORIZATION_CREDENTIAL, `$1$2${REDACTED}`);
}

const IDENTIFIER_KEY = /(?:^|_)id$|Id$/;
const SIGNED_THINKING_TYPES = new Set(["thinking", "thinking_delta"]);

/**
 * Whether a string field must reach the log byte for byte: identifiers, and the parts of
 * Claude thinking blocks the API verifies against their signature (the signature itself,
 * thinking text and the encrypted payload of redacted thinking). Transcript repair replays
 * them, and a modified block makes the resumed request fail. A secret the model wrote into
 * its thinking therefore stays in the log.
 */
export function isScrubExemptField(holder: unknown, key: string): boolean {
  if (key === "signature" || IDENTIFIER_KEY.test(key)) return true;
  if (typeof holder !== "object" || holder === null) return false;
  const type = (holder as { type?: unknown }).type;
  if (key === "data") return type === "redacted_thinking";
  return key === "thinking" && typeof type === "string" && SIGNED_THINKING_TYPES.has(type);
}
