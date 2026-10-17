import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";

export const McpServerTransportType = Schema.Literals(["stdio", "sse", "http"]);
export type McpServerTransportType = typeof McpServerTransportType.Type;

const McpStringRecord = Schema.Record(TrimmedNonEmptyString, Schema.String);
const McpStringArray = Schema.Array(TrimmedNonEmptyString);
export const McpArgArray = Schema.Array(Schema.String);
export type McpArgArray = typeof McpArgArray.Type;
const McpPort = PositiveInt.check(Schema.isLessThanOrEqualTo(65535));
export const McpHttpUrl = TrimmedNonEmptyString.check(
  Schema.makeFilter((value: string) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }),
);
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
  oauthClientId: Schema.optional(TrimmedNonEmptyString),
  oauthCallbackPort: Schema.optional(McpPort),
  oauthCallbackUrl: Schema.optional(TrimmedNonEmptyString),
  oauthResource: Schema.optional(TrimmedNonEmptyString),
};

const McpStdioServerDefinition = Schema.Struct({
  type: Schema.Literal("stdio"),
  command: TrimmedNonEmptyString,
  args: Schema.optional(McpArgArray),
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

export const McpProjectServersConfig = Schema.Record(Schema.String, McpServerDefinition);
export type McpProjectServersConfig = typeof McpProjectServersConfig.Type;

// Writes validate changed entries; persisted decoding remains lenient for legacy repair.
export const McpServerWriteDefinition = Schema.Union([
  McpStdioServerDefinition.mapFields((fields) => ({
    ...fields,
    oauthCallbackUrl: Schema.optional(McpHttpUrl),
  })),
  McpRemoteServerDefinition.mapFields((fields) => ({
    ...fields,
    url: McpHttpUrl,
    oauthCallbackUrl: Schema.optional(McpHttpUrl),
  })),
]);
export type McpServerWriteDefinition = typeof McpServerWriteDefinition.Type;
export const McpProjectServersWriteConfig = Schema.Record(
  TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  McpServerWriteDefinition,
);
export type McpProjectServersWriteConfig = typeof McpProjectServersWriteConfig.Type;

const ClaudeAgentStdioMcpServerConfig = Schema.Struct({
  type: Schema.Literal("stdio"),
  command: TrimmedNonEmptyString,
  args: Schema.optional(McpArgArray),
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
  oauth: Schema.optional(
    Schema.Struct({
      client_id: TrimmedNonEmptyString,
    }),
  ),
  oauth_resource: Schema.optional(TrimmedNonEmptyString),
};

const CodexStdioMcpServerEntry = Schema.Struct({
  type: Schema.Literal("stdio"),
  command: TrimmedNonEmptyString,
  args: Schema.optional(McpArgArray),
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
