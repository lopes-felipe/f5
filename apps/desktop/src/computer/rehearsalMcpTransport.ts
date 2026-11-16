import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import { Schema } from "effect";
import { ComputerToolOutcomeCode } from "@t3tools/contracts";

export const MCP_DIAGNOSTIC_PREFIX = "F5_REHEARSAL_MCP ";
export const RehearsalMcpTransportReceipt = Schema.Struct({
  method: Schema.Literals(["initialize", "tools/list", "tools/call", "notification", "other"]),
  sessionHeader: Schema.Boolean,
  status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  bounded: Schema.Boolean,
  requestDecoded: Schema.Boolean,
  responseDecoded: Schema.Boolean,
  completed: Schema.Boolean,
  outcome: Schema.Union([
    ComputerToolOutcomeCode,
    Schema.Literals([
      "ok",
      "accepted",
      "unreadable",
      "tool-error",
      "http-error",
      "rpc-error",
      "credential-refused",
      "expired-session",
      "invalid-json",
      "internal-error",
      "rpc-parse-error",
      "rpc-invalid-request",
      "rpc-method-not-found",
      "rpc-invalid-params",
      "connection-closed",
    ]),
  ]),
});
export type RehearsalMcpTransportReceipt = typeof RehearsalMcpTransportReceipt.Type;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Raw bytes exist only until decoding; only fixed metadata leaves this observer. */
class BoundedBody {
  private chunks: Buffer[] = [];
  private bytes = 0;
  overflow = false;
  add(chunk: unknown, encoding?: unknown): void {
    try {
      if (this.overflow) return;
      const format =
        typeof encoding === "string" && Buffer.isEncoding(encoding) ? encoding : "utf8";
      const size =
        typeof chunk === "string"
          ? Buffer.byteLength(chunk, format)
          : chunk instanceof Uint8Array
            ? chunk.byteLength
            : undefined;
      if (size === undefined) return;
      this.bytes += size;
      if (this.bytes > 64 * 1024) {
        this.overflow = true;
        this.chunks = [];
      } else
        this.chunks.push(
          typeof chunk === "string" ? Buffer.from(chunk, format) : Buffer.from(chunk as Uint8Array),
        );
    } catch {
      this.overflow = true;
      this.chunks = [];
    }
  }
  json(): Record<string, unknown> | undefined {
    const chunks = this.chunks;
    this.chunks = [];
    if (this.overflow) return undefined;
    try {
      return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      return undefined;
    }
  }
}

function outcome(
  status: number,
  body: Record<string, unknown> | undefined,
): RehearsalMcpTransportReceipt["outcome"] {
  const httpErrors: Record<string, RehearsalMcpTransportReceipt["outcome"]> = {
    invalid_mcp_credential: "credential-refused",
    expired_mcp_session: "expired-session",
    invalid_json: "invalid-json",
    internal_error: "internal-error",
  };
  if (status >= 400)
    return typeof body?.error === "string" && Object.hasOwn(httpErrors, body.error)
      ? httpErrors[body.error]!
      : "http-error";
  if (status === 202) return "accepted";
  if (!body) return "unreadable";
  const error = record(body.error);
  if (error) {
    switch (error.code) {
      case -32700:
        return "rpc-parse-error";
      case -32600:
        return "rpc-invalid-request";
      case -32601:
        return "rpc-method-not-found";
      case -32602:
        return "rpc-invalid-params";
      default:
        return "rpc-error";
    }
  }
  const result = record(body.result);
  if (result?.isError === true) {
    const tag = record(record(result.structuredContent)?.error)?._tag;
    return Schema.is(ComputerToolOutcomeCode)(tag) ? tag : "tool-error";
  }
  return result ? "ok" : "unreadable";
}

/** Development-only observation of the real HTTP boundary. It cannot answer
 * consent, authorize, execute or change bytes, callbacks, headers or status. */
export function observeComputerMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  emit: (receipt: RehearsalMcpTransportReceipt) => void,
): void {
  if (request.url !== "/mcp/computer") return;
  const input = new BoundedBody();
  const output = new BoundedBody();
  let method: RehearsalMcpTransportReceipt["method"] = "other";
  let requestDecoded = false;
  request.on("data", (chunk: unknown) => input.add(chunk));
  request.once("end", () => {
    const body = input.json();
    requestDecoded = !!body;
    if (["initialize", "tools/list", "tools/call"].includes(String(body?.method)))
      method = body!.method as RehearsalMcpTransportReceipt["method"];
    else if (typeof body?.method === "string" && body.method.startsWith("notifications/"))
      method = "notification";
  });
  const write = response.write;
  const end = response.end;
  response.write = function (this: ServerResponse, ...args: unknown[]) {
    output.add(args[0], args[1]);
    return Reflect.apply(write, this, args);
  };
  response.end = function (this: ServerResponse, ...args: unknown[]) {
    output.add(args[0], args[1]);
    return Reflect.apply(end, this, args);
  };
  let settled = false;
  const publish = (completed: boolean) => {
    if (settled) return;
    settled = true;
    const body = output.json();
    try {
      emit({
        method,
        sessionHeader: typeof request.headers["mcp-session-id"] === "string",
        status: response.statusCode,
        bounded: !input.overflow && !output.overflow,
        requestDecoded,
        responseDecoded: !!body,
        completed,
        outcome: completed ? outcome(response.statusCode, body) : "connection-closed",
      });
    } catch {
      /* Diagnostics cannot change the completed response. */
    }
  };
  response.once("finish", () => publish(true));
  response.once("close", () => {
    if (!response.writableFinished) publish(false);
  });
}

/** Only the guarded development runner creates this bootstrap. Production entry
 * and argv are preserved; inherited IPC remains the sole execution authority. */
export function rehearsalMcpBackendBootstrap(backendEntry: string, observerEntry: string): string {
  if (![backendEntry, observerEntry].every(isAbsolute))
    throw new Error("Rehearsal paths must be absolute.");
  return `
if(process.env.F5_DESKTOP_COMPUTER_HOST!=='ipc'||typeof process.send!=='function')throw new Error('Unexpected diagnostic backend');
const http=require('node:http');
const {syncBuiltinESMExports}=require('node:module');
const {pathToFileURL}=require('node:url');
const {observeComputerMcpRequest,MCP_DIAGNOSTIC_PREFIX}=require(${JSON.stringify(observerEntry)});
const create=http.createServer;
http.createServer=function(...args){
  const server=create.apply(this,args);
  server.prependListener('request',(request,response)=>observeComputerMcpRequest(request,response,
    receipt=>process.stdout.write(MCP_DIAGNOSTIC_PREFIX+JSON.stringify(receipt)+'\\n')));
  return server;
};
syncBuiltinESMExports();
process.argv[1]=${JSON.stringify(backendEntry)};
import(pathToFileURL(process.argv[1]).href).catch(()=>process.exit(1));
`;
}
