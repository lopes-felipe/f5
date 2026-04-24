import { Schema } from "effect";

export const ProviderKind = Schema.Literals(["codex", "claudeAgent"]);
export type ProviderKind = typeof ProviderKind.Type;
