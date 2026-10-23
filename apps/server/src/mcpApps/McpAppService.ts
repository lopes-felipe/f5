import { formatMcpAppContextEntry, MAX_MCP_APP_CONTEXT_BYTES } from "./McpAppContext.ts";
import { stringifyWithinBytes } from "@t3tools/shared/boundedJson";
import type {
  McpAppCallToolInput,
  McpAppReadResourceInput,
  McpAppToolInfoInput,
  McpAppToolInfo,
  McpAppUpdateModelContextInput,
} from "@t3tools/contracts";
import {
  readMcpAppReference,
  readMcpAppToolResult,
  findMcpAppToolPolicy,
} from "@t3tools/shared/mcpApp";
import { Data, Effect, Layer, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";

export class McpAppError extends Data.TaggedError("McpAppError")<{ readonly message: string }> {}
const failure = () =>
  new McpAppError({
    message:
      "The MCP app request could not complete. Check the live session before retrying; tool calls are never retried automatically.",
  });
const encode = (value: unknown, maxBytes: number) =>
  Effect.try({
    try: () => {
      const json = stringifyWithinBytes(value, maxBytes);
      if (json === undefined) throw new Error("MCP app size limit");
      return json;
    },
    catch: () => new McpAppError({ message: "This MCP app request exceeds its size limit." }),
  });
export class McpAppService extends ServiceMap.Service<
  McpAppService,
  Effect.Success<typeof makeMcpAppService>
>()("t3/mcpApps/McpAppService") {}
export const makeMcpAppService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const provider = yield* ProviderService;
  const authorize = (input: { threadId: McpAppToolInfoInput["threadId"]; attachmentId: string }) =>
    Effect.gen(function* () {
      const thread = (yield* engine.getReadModel()).threads.find(
        (thread) => thread.id === input.threadId && !thread.deletedAt && !thread.archivedAt,
      );
      if (!thread || thread.session?.providerName !== "codex" || !provider.mcpApps)
        return yield* new McpAppError({ message: "Send a message to reconnect." });
      const rows = yield* sql<{
        reference: string;
      }>`SELECT i.reference_json AS reference FROM mcp_app_instances i
      JOIN projection_thread_activities a ON a.activity_id=i.activity_id AND a.thread_id=i.thread_id
      JOIN attachments f ON f.attachment_id=i.attachment_id AND f.lifecycle='ready'
      JOIN attachment_owners o ON o.attachment_id=i.attachment_id AND o.owner_kind='activity' AND o.owner_id=i.activity_id
      WHERE i.thread_id=${input.threadId} AND i.attachment_id=${input.attachmentId} AND a.kind='mcpApp'
      AND json_extract(a.payload_json,'$.reference.attachmentId')=i.attachment_id LIMIT 1`;
      const reference = yield* Effect.try({
        try: () => readMcpAppReference(JSON.parse(rows[0]?.reference ?? "null")),
        catch: failure,
      });
      if (!reference) return yield* failure();
      return { reference, apps: provider.mcpApps };
    });
  const inspectTool = (input: McpAppToolInfoInput) =>
    Effect.gen(function* () {
      const { reference, apps } = yield* authorize(input);
      const sessionIdentity = yield* apps.identity(input.threadId);
      const tools = yield* apps.listTools({ threadId: input.threadId, server: reference.server });
      if ((yield* apps.identity(input.threadId)) !== sessionIdentity) return yield* failure();
      const policy = findMcpAppToolPolicy(tools, input.name);
      if (!policy)
        return yield* new McpAppError({ message: "This tool is not available to the MCP app." });
      return { reference, apps, info: { ...policy, sessionIdentity } satisfies McpAppToolInfo };
    });
  const toolInfo = (input: McpAppToolInfoInput) =>
    inspectTool(input).pipe(
      Effect.map((value) => value.info),
      Effect.mapError((error) => (error instanceof McpAppError ? error : failure())),
    );
  const callTool = (input: McpAppCallToolInput) =>
    Effect.gen(function* () {
      yield* encode(input.arguments, 65536);
      const { apps, reference, info } = yield* inspectTool(input);
      if (info.sessionIdentity !== input.sessionIdentity)
        return yield* new McpAppError({
          message: "The app session changed. Review the tool call again.",
        });
      if (!info.readOnlyHint && input.approved !== true)
        return yield* new McpAppError({ message: "User approval is required for this tool call." });
      // The mutation is sent once. A timeout or session change never triggers a replay.
      const response = yield* apps.callTool({
        threadId: input.threadId,
        server: reference.server,
        tool: input.name,
        arguments: input.arguments,
        sessionIdentity: input.sessionIdentity,
        approved: input.approved === true,
      });
      yield* encode(response, 256 * 1024);
      const result = readMcpAppToolResult(response);
      if (!result) return yield* failure();
      return result;
    }).pipe(Effect.mapError((error) => (error instanceof McpAppError ? error : failure())));
  const readResource = (input: McpAppReadResourceInput) =>
    Effect.gen(function* () {
      const { apps, reference } = yield* authorize(input);
      const response = yield* apps.readResource({
        threadId: input.threadId,
        server: reference.server,
        uri: input.uri,
      });
      yield* encode(response, 256 * 1024);
      return response;
    }).pipe(Effect.mapError((error) => (error instanceof McpAppError ? error : failure())));
  const updateModelContext = (input: McpAppUpdateModelContextInput) =>
    Effect.gen(function* () {
      const { reference } = yield* authorize(input);
      const context = {
        ...(input.content === undefined ? {} : { content: input.content }),
        ...(input.structuredContent === undefined
          ? {}
          : { structuredContent: input.structuredContent }),
      };
      const json = yield* encode(context, 32768);
      const message = formatMcpAppContextEntry(reference.server, reference.tool, context);
      if (!message)
        return yield* new McpAppError({
          message: "The app state exceeds this thread's context budget.",
        });
      const messageBytes = Buffer.byteLength(message) + 1;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (!input.content?.length && input.structuredContent === undefined) {
            yield* sql`DELETE FROM mcp_app_model_context WHERE thread_id=${input.threadId} AND server=${reference.server} AND resource_uri=${reference.resourceUri}`;
            return;
          }
          const usage = (yield* sql<{
            count: number;
            bytes: number;
          }>`SELECT count(*) AS count,coalesce(sum(message_bytes),0) AS bytes FROM mcp_app_model_context WHERE thread_id=${input.threadId} AND NOT (server=${reference.server} AND resource_uri=${reference.resourceUri})`)[0];
          if (!usage || usage.bytes + messageBytes > MAX_MCP_APP_CONTEXT_BYTES)
            return yield* new McpAppError({
              message: "This thread's MCP app context budget is full.",
            });
          if (usage.count >= 20)
            return yield* new McpAppError({
              message: "This thread has reached its MCP app context limit.",
            });
          yield* sql`INSERT INTO mcp_app_model_context(attachment_id,thread_id,server,resource_uri,context_json,message_bytes,updated_at) VALUES(${input.attachmentId},${input.threadId},${reference.server},${reference.resourceUri},${json},${messageBytes},${new Date().toISOString()}) ON CONFLICT(thread_id,server,resource_uri) DO UPDATE SET attachment_id=excluded.attachment_id,context_json=excluded.context_json,message_bytes=excluded.message_bytes,updated_at=excluded.updated_at`;
        }),
      );
    }).pipe(Effect.mapError((error) => (error instanceof McpAppError ? error : failure())));
  return { toolInfo, callTool, readResource, updateModelContext };
});
export const McpAppServiceLive = Layer.effect(McpAppService, makeMcpAppService);
