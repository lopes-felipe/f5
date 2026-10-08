import { Schema } from "effect";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";
import { McpProjectServersConfig } from "./mcpServer";

const CodexProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
  launchArgs: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});

export const ClaudeThinkingDisplay = Schema.Literals(["summarized", "omitted"]);
export type ClaudeThinkingDisplay = typeof ClaudeThinkingDisplay.Type;

/**
 * Typed Claude thinking configuration. Mirrors the Agent SDK `ThinkingConfig`
 * and replaces the deprecated `maxThinkingTokens`, which stays readable for
 * persisted settings and is never rewritten.
 */
export const ClaudeThinkingOption = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("adaptive"),
    display: Schema.optionalKey(ClaudeThinkingDisplay),
  }),
  Schema.Struct({
    type: Schema.Literal("enabled"),
    budgetTokens: Schema.optionalKey(PositiveInt),
    display: Schema.optionalKey(ClaudeThinkingDisplay),
  }),
  Schema.Struct({ type: Schema.Literal("disabled") }),
]);
export type ClaudeThinkingOption = typeof ClaudeThinkingOption.Type;

export const ClaudeProviderStartOptions = Schema.Struct({
  autoCompactWindow: Schema.optional(NonNegativeInt),
  resumeCompactionPrompt: Schema.optional(Schema.Boolean),
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  permissionMode: Schema.optional(TrimmedNonEmptyString),
  /** @deprecated Legacy input; prefer `thinking`. Kept for persisted settings. */
  maxThinkingTokens: Schema.optional(NonNegativeInt),
  thinking: Schema.optional(ClaudeThinkingOption),
  subagentsEnabled: Schema.optional(Schema.Boolean),
  subagentModel: Schema.optional(TrimmedNonEmptyString),
  launchArgs: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
});

const CursorProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  apiEndpoint: Schema.optional(TrimmedNonEmptyString),
});

const OpenCodeProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  serverUrl: Schema.optional(TrimmedNonEmptyString),
  serverPassword: Schema.optional(TrimmedNonEmptyString),
});

const GrokProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
});

export const ProviderStartOptions = Schema.Struct({
  mcpServers: Schema.optional(McpProjectServersConfig),
  codex: Schema.optional(CodexProviderStartOptions),
  claudeAgent: Schema.optional(ClaudeProviderStartOptions),
  cursor: Schema.optional(CursorProviderStartOptions),
  opencode: Schema.optional(OpenCodeProviderStartOptions),
  grok: Schema.optional(GrokProviderStartOptions),
});
export type ProviderStartOptions = typeof ProviderStartOptions.Type;
