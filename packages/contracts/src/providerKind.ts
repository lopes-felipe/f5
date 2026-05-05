import { Schema } from "effect";

export const KNOWN_PROVIDER_KINDS = ["codex", "claudeAgent", "cursor", "opencode"] as const;
export const ProviderKind = Schema.Literals(["codex", "claudeAgent", "cursor", "opencode"]);
export type ProviderKind = typeof ProviderKind.Type;

export function isKnownProviderKind(value: unknown): value is ProviderKind {
  return typeof value === "string" && (KNOWN_PROVIDER_KINDS as readonly string[]).includes(value);
}
