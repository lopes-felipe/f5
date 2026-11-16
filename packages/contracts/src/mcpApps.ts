import { Schema } from "effect";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

const Name = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const AppFields = { threadId: ThreadId, attachmentId: Name };
export const McpAppToolInfoInput = Schema.Struct({ ...AppFields, name: Name });
export type McpAppToolInfoInput = typeof McpAppToolInfoInput.Type;
export const McpAppCallToolInput = Schema.Struct({
  ...McpAppToolInfoInput.fields,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
  approved: Schema.optionalKey(Schema.Boolean),
  sessionIdentity: Name,
});
export type McpAppCallToolInput = typeof McpAppCallToolInput.Type;
export const McpAppReadResourceInput = Schema.Struct({
  ...AppFields,
  uri: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});
export type McpAppReadResourceInput = typeof McpAppReadResourceInput.Type;
export const McpAppUpdateModelContextInput = Schema.Struct({
  ...AppFields,
  content: Schema.optionalKey(Schema.Array(Schema.Unknown).check(Schema.isMaxLength(100))),
  structuredContent: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type McpAppUpdateModelContextInput = typeof McpAppUpdateModelContextInput.Type;
export const McpAppToolInfo = Schema.Struct({
  name: Name,
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1000))),
  readOnlyHint: Schema.Boolean,
  sessionIdentity: Name,
});
export type McpAppToolInfo = typeof McpAppToolInfo.Type;
export const McpAppToolResult = Schema.Struct({
  content: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(1000)),
  structuredContent: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  isError: Schema.optionalKey(Schema.Boolean),
  _meta: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type McpAppToolResult = typeof McpAppToolResult.Type;
export const MCP_APPS_WS_METHODS = {
  toolInfo: "mcpApps.toolInfo",
  callTool: "mcpApps.callTool",
  readResource: "mcpApps.readResource",
  updateModelContext: "mcpApps.updateModelContext",
} as const;
