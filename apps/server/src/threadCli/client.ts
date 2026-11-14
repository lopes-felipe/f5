import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { z } from "zod";
import { readAgentBridgeLocalCredentials } from "../agentBridge/localCredentials.ts";
import { ownerCredentialsPath, sessionSchema, readSchema, type messageSchema } from "./protocol.ts";

const envelopeSchema = z.object({
  id: z.number(),
  error: z.object({ message: z.string() }).optional(),
  result: z.unknown().optional(),
});
const toolSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
});

export type ToolCall = <S extends z.ZodType>(
  tool: string,
  args: Record<string, unknown>,
  schema: S,
) => Promise<z.output<S>>;

export async function readFullCliMessage(
  call: ToolCall,
  threadId: string,
  message: z.output<typeof messageSchema>,
) {
  let text = message.text;
  let offset = message.nextTextOffset;
  while (offset !== null) {
    const page = await call(
      "f5_thread_read",
      { threadId, itemId: message.id, textOffset: offset },
      readSchema,
    );
    const chunk = page.messages[0];
    if (!chunk || (chunk.nextTextOffset !== null && chunk.nextTextOffset <= offset))
      throw new Error("Invalid message continuation.");
    text += chunk.text;
    offset = chunk.nextTextOffset;
  }
  return { ...message, text, nextTextOffset: null };
}

export async function readCliThread(call: ToolCall, threadId: string, messages: number) {
  let page = await call("f5_thread_read", { threadId, messages }, readSchema);
  const result = { ...page, messages: [] as Array<z.output<typeof messageSchema>> };
  while (true) {
    for (const message of page.messages)
      result.messages.push(await readFullCliMessage(call, threadId, message));
    if (page.nextCursor === null) break;
    page = await call(
      "f5_thread_read",
      { threadId, messages, cursor: page.nextCursor, anchorId: result.anchorId },
      readSchema,
    );
  }
  return { ...result, nextCursor: null };
}

/** The bootstrap token can only mint a temporary identity; all work uses that identity. */
export async function openThreadClient(stateDir: string) {
  const credentials = await readAgentBridgeLocalCredentials(ownerCredentialsPath(stateDir));
  if (!credentials)
    throw new Error("No running F5 server uses " + stateDir + ". Start F5, then retry.");
  const endpoint = "http://127.0.0.1:" + credentials.port + "/mcp";
  let nextId = 0;
  const callWith =
    (token: string, signal?: AbortSignal): ToolCall =>
    async (tool, args, schema) => {
      const id = nextId++;
      const response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          accept: "application/json",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: tool, arguments: args },
        }),
        signal: AbortSignal.any([
          AbortSignal.timeout(tool === "f5_cli_close" || tool === "f5_cli_open" ? 5000 : 120_000),
          ...(signal ? [signal] : []),
        ]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(
          "F5 thread CLI returned HTTP " + response.status + ". The server may have restarted.",
        );
      }
      const envelope = envelopeSchema.parse(await response.json());
      if (envelope.id !== id || envelope.error)
        throw new Error(envelope.error?.message ?? "Mismatched F5 response.");
      const result = toolSchema.parse(envelope.result);
      if (result.isError) {
        const detail = z.object({ error: z.string() }).safeParse(result.structuredContent);
        throw new Error(detail.success ? detail.data.error : "F5 thread tool failed.");
      }
      return schema.parse(result.structuredContent);
    };
  const issued = await callWith(credentials.token)("f5_cli_open", {}, sessionSchema);
  return {
    call: (signal?: AbortSignal) => callWith(issued.token, signal),
    close: () =>
      callWith(issued.token)("f5_cli_close", {}, z.object({}))
        .then(() => undefined)
        .catch(() => undefined),
  };
}

export async function withThreadClient<A>(
  stateDir: string,
  run: (call: ToolCall) => Promise<A>,
): Promise<A> {
  const client = await openThreadClient(stateDir);
  try {
    return await run(client.call());
  } finally {
    await client.close();
  }
}

/** Real paths handle symlinked roots; the deepest containing project wins. */
export async function resolveCliProject<T extends { id: string; workspaceRoot: string }>(
  projects: ReadonlyArray<T>,
  identifier: string,
  cwd = process.cwd(),
): Promise<T> {
  const byId = projects.find((p) => p.id === identifier);
  if (byId) return byId;
  const real = (path: string) => FS.realpath(path).catch(() => path);
  const target = await real(Path.resolve(cwd, identifier));
  const roots = await Promise.all(
    projects.map(async (project) => ({ project, root: await real(project.workspaceRoot) })),
  );
  const match = roots
    .filter(({ root }) => {
      const relative = Path.relative(root, target);
      return (
        relative === "" ||
        (relative !== ".." && !relative.startsWith(".." + Path.sep) && !Path.isAbsolute(relative))
      );
    })
    .sort((a, b) => b.root.length - a.root.length)[0];
  if (!match)
    throw new Error(
      "No F5 project matches '" + identifier + "'. Pass a project id or a path inside a project.",
    );
  return match.project;
}
