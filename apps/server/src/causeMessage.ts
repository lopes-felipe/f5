import { Cause } from "effect";

export function userFacingCauseMessage(
  cause: Cause.Cause<unknown>,
  fallback: string,
  options: { readonly maxLength?: number } = {},
): string {
  const squashed = Cause.squash(cause);
  const message =
    (squashed instanceof Error ? squashed.message : String(squashed)).replace(/\s+/g, " ").trim() ||
    fallback;
  const maxLength = options.maxLength;
  return maxLength !== undefined && message.length > maxLength
    ? `${message.slice(0, Math.max(0, maxLength - 1))}…`
    : message;
}
