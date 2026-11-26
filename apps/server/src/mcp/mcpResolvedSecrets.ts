/**
 * Secret values F5 resolved into MCP server definitions. An env or header value is
 * already redacted from diagnostics as a whole; a secret inside an argument or URL
 * is not, so the hub and the connection test look its values up here to redact them
 * from errors and stderr. The values already live in this process; this only
 * remembers which strings are secret.
 */
const resolved = new Set<string>();
/** Field values a secret was substituted into, redacted as a whole. */
const fields = new Set<string>();

/**
 * Short values are not redacted on their own: redacting them would mangle diagnostics.
 * The whole field that holds one (for example `--token=abc`) still is, when it is
 * at least this long.
 */
const MIN_SECRET_LENGTH = 8;

/** Remembers one resolved secret value, as stored and as encoded into a URL. */
export function rememberResolvedMcpSecret(value: string): void {
  if (!value) return;
  resolved.add(value);
  const encoded = encodeURIComponent(value);
  if (encoded !== value) resolved.add(encoded);
}

/**
 * Remembers a field value a secret was substituted into, so a composite value (a
 * secret inside a longer argument, header or URL) is redacted as a whole.
 */
export function rememberResolvedMcpField(value: string): void {
  if (value) fields.add(value);
}

/** The remembered secret values and fields that occur in `text`, longest first. */
export function resolvedMcpSecretsIn(text: string): string[] {
  const found: string[] = [];
  for (const value of new Set([...resolved, ...fields]))
    if (value.length >= MIN_SECRET_LENGTH && text.includes(value)) found.push(value);
  return found.toSorted((left, right) => right.length - left.length);
}

/**
 * `text` with every remembered secret value replaced by a fixed marker, so what is
 * stored or shown (such as a server's pin identity) never holds one, and stays the
 * same when the secret is rotated.
 */
export function maskResolvedMcpSecrets(text: string): string {
  let masked = text;
  const values = [...resolved]
    .filter((value) => masked.includes(value))
    .toSorted((left, right) => right.length - left.length);
  for (const value of values) masked = masked.split(value).join("${f5-secret}");
  return masked;
}
