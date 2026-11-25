import { FilesystemPath } from "./baseSchemas";
import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";

export const McpServerTransportType = Schema.Literals(["stdio", "sse", "http"]);
export type McpServerTransportType = typeof McpServerTransportType.Type;

const McpStringRecord = Schema.Record(TrimmedNonEmptyString, Schema.String);
const McpStringArray = Schema.Array(TrimmedNonEmptyString);
export const McpArgArray = Schema.Array(Schema.String);
export type McpArgArray = typeof McpArgArray.Type;
const McpPort = PositiveInt.check(Schema.isLessThanOrEqualTo(65535));
const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};
export const McpHttpUrl = TrimmedNonEmptyString.check(Schema.makeFilter(isHttpUrl));
const ENV_REFERENCE = /\$\{env:[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/gu;
/**
 * A server URL that may contain `${env:NAME}` references, resolved when the server
 * starts. A URL that is one reference is accepted; otherwise it must parse with each
 * reference standing in for a host-safe placeholder.
 */
export const McpHttpUrlTemplate = TrimmedNonEmptyString.check(
  Schema.makeFilter(
    (value: string) =>
      /^\$\{env:[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}$/u.test(value) ||
      isHttpUrl(value.replace(ENV_REFERENCE, "x")),
  ),
);
const UnsupportedMcpField = Schema.optional(Schema.Undefined);

export const McpConnectionScope = Schema.Literals(["session", "shared"]);
export type McpConnectionScope = typeof McpConnectionScope.Type;

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
  /**
   * How F5's MCP hub connects: one connection per provider session (`session`,
   * the default for stdio) or one per profile shared by sessions (`shared`, the
   * default for remote servers).
   */
  connectionScope: Schema.optional(McpConnectionScope),
};

const McpStdioServerDefinition = Schema.Struct({
  type: Schema.Literal("stdio"),
  command: TrimmedNonEmptyString,
  args: Schema.optional(McpArgArray),
  env: Schema.optional(McpStringRecord),
  cwd: Schema.optional(FilesystemPath),
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
    url: McpHttpUrlTemplate,
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
  timeout: Schema.optional(PositiveInt),
  type: Schema.Literal("stdio"),
  command: TrimmedNonEmptyString,
  args: Schema.optional(McpArgArray),
  env: Schema.optional(McpStringRecord),
  cwd: Schema.optional(FilesystemPath),
});

const ClaudeAgentRemoteMcpServerConfig = Schema.Struct({
  timeout: Schema.optional(PositiveInt),
  type: Schema.Literals(["sse", "http"]),
  url: TrimmedNonEmptyString,
  headers: Schema.optional(McpStringRecord),
  oauth: Schema.optional(
    Schema.Struct({
      clientId: Schema.optional(TrimmedNonEmptyString),
      callbackPort: Schema.optional(McpPort),
    }),
  ),
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
  cwd: Schema.optional(FilesystemPath),
  url: UnsupportedMcpField,
  http_headers: UnsupportedMcpField,
  ...CodexMcpServerCommonFields,
});

const CodexRemoteMcpServerEntry = Schema.Struct({
  type: Schema.Literals(["sse", "http"]),
  command: UnsupportedMcpField,
  args: UnsupportedMcpField,
  env: UnsupportedMcpField,
  cwd: UnsupportedMcpField,
  url: TrimmedNonEmptyString,
  http_headers: Schema.optional(McpStringRecord),
  ...CodexMcpServerCommonFields,
});

export const CodexMcpServerEntry = Schema.Union([
  CodexStdioMcpServerEntry,
  CodexRemoteMcpServerEntry,
]);
export type CodexMcpServerEntry = typeof CodexMcpServerEntry.Type;
