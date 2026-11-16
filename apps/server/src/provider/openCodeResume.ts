import { Effect, type FileSystem, type Path } from "effect";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { openCodeRuntimeErrorDetail, runOpenCodeSdk } from "./opencodeRuntime.ts";

export const OPENCODE_RESUME_VERSION = 1 as const;

export function parseOpenCodeResume(raw: unknown): { readonly sessionId: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (
    record.schemaVersion !== OPENCODE_RESUME_VERSION ||
    typeof record.sessionId !== "string" ||
    record.sessionId.trim().length === 0
  ) {
    return undefined;
  }
  return { sessionId: record.sessionId.trim() };
}

/** A fork carries native history even though it has a new session identity. */
export function isOpenCodeHistoryContinuation(previous: unknown, current: unknown): boolean {
  const from = parseOpenCodeResume(previous);
  const to = parseOpenCodeResume(current);
  return (
    !!from &&
    !!to &&
    (from.sessionId === to.sessionId ||
      (current as Record<string, unknown>).forkedFromSessionId === from.sessionId)
  );
}

/** The SDK normally throws just the body, discarding the authoritative HTTP status. */
export function getOpenCodeResumeSession(client: OpencodeClient, sessionId: string) {
  return runOpenCodeSdk("session.get", async (signal) => {
    const result = await client.session.get(
      { sessionID: sessionId },
      { signal, throwOnError: false },
    );
    if (result.response?.ok === false) {
      throw new Error(openCodeRuntimeErrorDetail(result.error), {
        cause: { status: result.response.status, body: result.error },
      });
    }
    return result.data;
  });
}

/** Only a structured, confirmed miss may replace a persisted conversation. */
export function isOpenCodeNotFound(cause: unknown): boolean {
  const seen = new Set<unknown>();
  const queue: Array<unknown> = [cause];
  for (let steps = 0; queue.length > 0 && steps < 32; steps += 1) {
    const node = queue.shift();
    if (node === null || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    const record = node as Record<string, unknown>;
    const response = record.response;
    const statuses = [
      record.status,
      record.statusCode,
      response !== null && typeof response === "object"
        ? (response as { readonly status?: unknown }).status
        : undefined,
    ].filter((status): status is number => typeof status === "number");
    if (statuses.includes(404)) return true;
    // A server/auth failure must not be reclassified by an echoed NotFoundError body.
    if (statuses.length > 0) continue;
    if (typeof record.name === "string" && record.name.toLowerCase() === "notfounderror") {
      return true;
    }
    for (const key of ["cause", "body", "error", "data"] as const) {
      if (record[key] !== undefined) queue.push(record[key]);
    }
  }
  return false;
}

/** Normalize dot segments and symlinks before deciding to fork into a new cwd. */
export function isSameOpenCodeDirectory(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  left: string,
  right: string,
): Effect.Effect<boolean> {
  const lexicalLeft = path.resolve(left);
  const lexicalRight = path.resolve(right);
  if (lexicalLeft === lexicalRight) return Effect.succeed(true);
  const canonicalize = (lexical: string) =>
    fileSystem.realPath(lexical).pipe(Effect.orElseSucceed(() => lexical));
  return Effect.gen(function* () {
    return (yield* canonicalize(lexicalLeft)) === (yield* canonicalize(lexicalRight));
  });
}
