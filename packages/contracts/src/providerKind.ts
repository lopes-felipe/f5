import { Schema } from "effect";

export const KNOWN_PROVIDER_KINDS = ["codex", "claudeAgent", "cursor", "opencode", "grok"] as const;
export const ProviderKind = Schema.Literals(["codex", "claudeAgent", "cursor", "opencode", "grok"]);
export type ProviderKind = typeof ProviderKind.Type;

export function isKnownProviderKind(value: unknown): value is ProviderKind {
  return typeof value === "string" && (KNOWN_PROVIDER_KINDS as readonly string[]).includes(value);
}
