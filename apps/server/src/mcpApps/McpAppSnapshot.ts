import type { ThreadId } from "@t3tools/contracts";
import {
  injectMcpAppCsp,
  injectMcpAppCookieBootstrap,
  injectMcpAppThemeBootstrap,
  MCP_APP_MAX_HTML_BYTES,
  MCP_APP_MIME_TYPE,
  readMcpAppCsp,
  readMcpAppPermissions,
  readMcpAppReference,
  type McpAppReference,
} from "@t3tools/shared/mcpApp";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ingestActivityAttachment } from "../activityAttachments.ts";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Select exactly the requested UI resource. Refused documents remain ordinary tool rows. */
export function readMcpAppDocument(response: unknown, uri: string) {
  const contents = record(response)?.contents;
  if (!Array.isArray(contents) || contents.length > 100) return undefined;
  for (const entry of contents) {
    const content = record(entry);
    if (
      !content ||
      content.uri !== uri ||
      typeof content.mimeType !== "string" ||
      content.mimeType.replace(/\s+/g, "").toLowerCase() !== MCP_APP_MIME_TYPE
    )
      continue;
    let html: string;
    if (typeof content.text === "string") {
      if (content.text.length > MCP_APP_MAX_HTML_BYTES) return undefined;
      html = content.text;
    } else if (typeof content.blob === "string") {
      if (
        content.blob.length > Math.ceil(MCP_APP_MAX_HTML_BYTES / 3) * 4 ||
        content.blob.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(content.blob)
      )
        return undefined;
      try {
        html = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.from(content.blob, "base64"),
        );
      } catch {
        return undefined;
      }
    } else continue;
    if (!html.trim() || Buffer.byteLength(html) > MCP_APP_MAX_HTML_BYTES) return undefined;
    const ui = record(record(content._meta)?.ui) ?? {};
    return {
      html,
      csp: readMcpAppCsp(ui.csp),
      permissions: readMcpAppPermissions(ui.permissions),
      prefersBorder: typeof ui.prefersBorder === "boolean" ? ui.prefersBorder : undefined,
    };
  }
  return undefined;
}

export const snapshotMcpApp = (input: {
  readonly attachmentsDir: string;
  readonly threadId: ThreadId;
  readonly activityId: string;
  readonly itemKey: string;
  readonly server: string;
  readonly tool: string;
  readonly resourceUri: string;
  readonly response: unknown;
}) =>
  Effect.gen(function* () {
    const document = readMcpAppDocument(input.response, input.resourceUri);
    if (!document || !input.resourceUri.startsWith("ui://")) return undefined;
    const sql = yield* SqlClient.SqlClient;
    const html = injectMcpAppCookieBootstrap(
      injectMcpAppThemeBootstrap(injectMcpAppCsp(document.html, document.csp)),
    );
    const attachment = yield* ingestActivityAttachment({
      attachmentsDir: input.attachmentsDir,
      threadId: input.threadId,
      itemKey: input.itemKey,
      activityId: input.activityId,
      file: {
        type: "file",
        name: "mcp-app.html",
        mimeType: MCP_APP_MIME_TYPE,
        bytes: Buffer.from(html),
      },
    });
    if (!attachment) return undefined;
    const reference = readMcpAppReference({
      attachmentId: attachment.attachmentId,
      server: input.server,
      tool: input.tool,
      resourceUri: input.resourceUri,
      ...(document.csp ? { csp: document.csp } : {}),
      ...(document.permissions ? { permissions: document.permissions } : {}),
      ...(document.prefersBorder !== undefined ? { prefersBorder: document.prefersBorder } : {}),
    });
    if (!reference) return undefined;
    const json = JSON.stringify(reference);
    if (Buffer.byteLength(json) > 65536) return undefined;
    yield* sql`INSERT INTO mcp_app_instances(attachment_id,thread_id,activity_id,reference_json,created_at) VALUES(${reference.attachmentId},${input.threadId},${input.activityId},${json},${new Date().toISOString()}) ON CONFLICT(attachment_id) DO NOTHING`;
    return reference satisfies McpAppReference;
  });
