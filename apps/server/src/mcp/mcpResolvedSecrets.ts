/**
 * Secret values F5 resolved into MCP server definitions. An env or header value is
 * already redacted from diagnostics as a whole; a secret inside an argument or URL
 * is not, so the hub looks its values up here to redact them from errors and stderr.
 * The values already live in this process; this only remembers which strings are secret.
 */
const resolved = new Set<string>();

/** Short values are never treated as secrets: redacting them would mangle diagnostics. */
const MIN_SECRET_LENGTH = 8;

export function rememberResolvedMcpSecret(value: string): void {
  if (value.length >= MIN_SECRET_LENGTH) resolved.add(value);
}

/** The remembered secret values that occur in `text`. */
export function resolvedMcpSecretsIn(text: string): string[] {
  const found: string[] = [];
  for (const value of resolved) if (text.includes(value)) found.push(value);
  return found;
}
