import { Schema } from "effect";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";
import { McpProjectServersConfig } from "./mcpServer";

const CodexProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
  launchArgs: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});

export const ClaudeProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  permissionMode: Schema.optional(TrimmedNonEmptyString),
  maxThinkingTokens: Schema.optional(NonNegativeInt),
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
