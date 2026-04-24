import { Schema } from "effect";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

export const McpServerTransportType = Schema.Literals(["stdio", "sse", "http"]);
export type McpServerTransportType = typeof McpServerTransportType.Type;

const McpStringRecord = Schema.Record(TrimmedNonEmptyString, Schema.String);
const McpStringArray = Schema.Array(TrimmedNonEmptyString);
const UnsupportedMcpField = Schema.optional(Schema.Undefined);

const McpCommonServerFields = {
  enabled: Schema.optional(Schema.Boolean),
  bearerTokenEnvVar: Schema.optional(TrimmedNonEmptyString),
  supportsParallelToolCalls: Schema.optional(Schema.Boolean),
  startupTimeoutSec: Schema.optional(NonNegativeInt),
  toolTimeoutSec: Schema.optional(NonNegativeInt),
  enabledTools: Schema.optional(McpStringArray),
  disabledTools: Schema.optional(McpStringArray),
  scopes: Schema.optional(McpStringArray),
  oauthResource: Schema.optional(TrimmedNonEmptyString),
};

const McpStdioServerDefinition = Schema.Struct({
  type: Schema.Literal("stdio"),
  command: TrimmedNonEmptyString,
  args: Schema.optional(McpStringArray),
  env: Schema.optional(McpStringRecord),
  cwd: Schema.optional(TrimmedNonEmptyString),
  url: UnsupportedMcpField,
  headers: UnsupportedMcpField,
  ...McpCommonServerFields,
});

const McpRemoteServerDefinition = Schema.Struct({
  type: Schema.Literals(["sse", "http"]),
  command: UnsupportedMcpField,
  args: UnsupportedMcpField,
  env: UnsupportedMcpField,
  cwd: UnsupportedMcpField,
  url: TrimmedNonEmptyString,
  headers: Schema.optional(McpStringRecord),
  ...McpCommonServerFields,
});

export const McpServerDefinition = Schema.Union([
  McpStdioServerDefinition,
  McpRemoteServerDefinition,
]);
export type McpServerDefinition = typeof McpServerDefinition.Type;

export const McpProjectServersConfig = Schema.Record(TrimmedNonEmptyString, McpServerDefinition);
export type McpProjectServersConfig = typeof McpProjectServersConfig.Type;

const ClaudeAgentStdioMcpServerConfig = Schema.Struct({
  type: Schema.Literal("stdio"),
  command: TrimmedNonEmptyString,
  args: Schema.optional(McpStringArray),
  env: Schema.optional(McpStringRecord),
  cwd: Schema.optional(TrimmedNonEmptyString),
});

const ClaudeAgentRemoteMcpServerConfig = Schema.Struct({
  type: Schema.Literals(["sse", "http"]),
  url: TrimmedNonEmptyString,
  headers: Schema.optional(McpStringRecord),
});

export const ClaudeAgentMcpServerConfig = Schema.Union([
  ClaudeAgentStdioMcpServerConfig,
  ClaudeAgentRemoteMcpServerConfig,
]);
export type ClaudeAgentMcpServerConfig = typeof ClaudeAgentMcpServerConfig.Type;

const CodexMcpServerCommonFields = {
  bearer_token_env_var: Schema.optional(TrimmedNonEmptyString),
  supports_parallel_tool_calls: Schema.optional(Schema.Boolean),
  startup_timeout_sec: Schema.optional(NonNegativeInt),
  tool_timeout_sec: Schema.optional(NonNegativeInt),
  enabled_tools: Schema.optional(McpStringArray),
  disabled_tools: Schema.optional(McpStringArray),
  scopes: Schema.optional(McpStringArray),
  oauth_resource: Schema.optional(TrimmedNonEmptyString),
};

const CodexStdioMcpServerEntry = Schema.Struct({
  type: Schema.Literal("stdio"),
  command: TrimmedNonEmptyString,
  args: Schema.optional(McpStringArray),
  env: Schema.optional(McpStringRecord),
  cwd: Schema.optional(TrimmedNonEmptyString),
  url: UnsupportedMcpField,
  headers: UnsupportedMcpField,
  ...CodexMcpServerCommonFields,
});

const CodexRemoteMcpServerEntry = Schema.Struct({
  type: Schema.Literals(["sse", "http"]),
  command: UnsupportedMcpField,
  args: UnsupportedMcpField,
  env: UnsupportedMcpField,
  cwd: UnsupportedMcpField,
  url: TrimmedNonEmptyString,
  headers: Schema.optional(McpStringRecord),
  ...CodexMcpServerCommonFields,
});

export const CodexMcpServerEntry = Schema.Union([
  CodexStdioMcpServerEntry,
  CodexRemoteMcpServerEntry,
]);
export type CodexMcpServerEntry = typeof CodexMcpServerEntry.Type;
