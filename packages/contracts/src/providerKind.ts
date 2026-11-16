import { Schema } from "effect";

export const KNOWN_PROVIDER_KINDS = [
  "codex",
  "claudeAgent",
  "cursor",
  "opencode",
  "grok",
  "antigravity",
  "muse",
  "acp",
  "pi",
] as const;
export const ProviderKind = Schema.Literals([
  "codex",
  "claudeAgent",
  "cursor",
  "opencode",
  "grok",
  "antigravity",
  "muse",
  "acp",
  "pi",
]);
export type ProviderKind = typeof ProviderKind.Type;

export function isKnownProviderKind(value: unknown): value is ProviderKind {
  return typeof value === "string" && (KNOWN_PROVIDER_KINDS as readonly string[]).includes(value);
}
