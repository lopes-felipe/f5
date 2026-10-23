import { isAbsolute, win32 } from "node:path";
import { createHash } from "node:crypto";
import { TurnId, type ThreadId } from "@t3tools/contracts";
import { stringifyWithinBytes } from "@t3tools/shared/boundedJson";
import { canonicalJsonHash } from "../../canonicalJsonHash.ts";
import { Effect } from "effect";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { piRecordField, piRecordString, type PiRpcRecord } from "./PiProtocol.ts";
import { PiRpcError } from "./PiRpc.ts";
import { parsePiSessionTree, piActiveBranch } from "./PiSessionTree.ts";

export interface PiBoundary {
  readonly turnId: string;
  readonly entryId: string;
  readonly kind?: "continuation";
}
export interface PiResumeCursor {
  readonly schemaVersion: 1;
  readonly sessionFile: string;
  readonly leafId: string | null;
  readonly boundaries: readonly PiBoundary[];
  readonly rewindSourceThreadId?: string;
  readonly rewindBeforeTurnId?: string;
  readonly rewindRetainedHash?: string;
  readonly rewindBoundaryKind?: "entries";
}
export function parsePiResumeCursor(value: unknown): PiResumeCursor | undefined {
  const file = piRecordString(value, "sessionFile");
  const leafId = piRecordField(value, "leafId");
  const boundaries = piRecordField(value, "boundaries");
  if (
    piRecordField(value, "schemaVersion") !== 1 ||
    !file ||
    file.length > 16_384 ||
    file.includes("\0") ||
    (!isAbsolute(file) && !win32.isAbsolute(file)) ||
    (leafId !== null &&
      (typeof leafId !== "string" ||
        !leafId.trim() ||
        leafId.trim() !== leafId ||
        leafId.length > 1024 ||
        leafId.includes("\0"))) ||
    !Array.isArray(boundaries) ||
    boundaries.length > 500
  )
    return undefined;
  const parsed: PiBoundary[] = [];
  const turns = new Set<string>(),
    entries = new Set<string>();
  for (const boundary of boundaries) {
    const turnId = piRecordString(boundary, "turnId"),
      entryId = piRecordString(boundary, "entryId");
    if (
      !turnId ||
      !entryId ||
      turnId.trim() !== turnId ||
      entryId.trim() !== entryId ||
      turnId.includes("\0") ||
      entryId.includes("\0") ||
      turnId.length > 1024 ||
      entryId.length > 1024 ||
      turns.has(turnId) ||
      entries.has(entryId)
    )
      return undefined;
    turns.add(turnId);
    entries.add(entryId);
    const kind = piRecordField(boundary, "kind");
    if (kind !== undefined && kind !== "continuation") return undefined;
    parsed.push({ turnId, entryId, ...(kind === "continuation" ? { kind } : {}) });
  }
  const rewindSourceThreadId = piRecordString(value, "rewindSourceThreadId");
  const rewindBeforeTurnId = piRecordString(value, "rewindBeforeTurnId");
  const rewindRetainedHash = piRecordString(value, "rewindRetainedHash");
  const rewindBoundaryKind = piRecordField(value, "rewindBoundaryKind");
  if (rewindBoundaryKind !== undefined && rewindBoundaryKind !== "entries") return undefined;
  if (rewindRetainedHash !== undefined && !/^[a-f0-9]{64}$/.test(rewindRetainedHash))
    return undefined;
  if (
    rewindSourceThreadId !== undefined &&
    ((!isAbsolute(rewindSourceThreadId) && !win32.isAbsolute(rewindSourceThreadId)) ||
      rewindSourceThreadId.includes("\0") ||
      rewindSourceThreadId.length > 16384)
  )
    return undefined;
  if (
    rewindBeforeTurnId !== undefined &&
    (!rewindBeforeTurnId.trim() || rewindBeforeTurnId.length > 1024)
  )
    return undefined;
  return {
    schemaVersion: 1,
    sessionFile: file,
    leafId,
    boundaries: parsed,
    ...(rewindSourceThreadId ? { rewindSourceThreadId } : {}),
    ...(rewindBeforeTurnId ? { rewindBeforeTurnId } : {}),
    ...(rewindRetainedHash ? { rewindRetainedHash } : {}),
    ...(rewindBoundaryKind === "entries" ? { rewindBoundaryKind } : {}),
  };
}

/** Responses are delivered by the native event pump so preceding lifecycle events cannot be skipped. */
export type PiHistoryRequest = (record: PiRpcRecord) => Effect.Effect<unknown, PiRpcError>;
export const piHistoryBoundaryHash = (ids: readonly string[]): string =>
  createHash("sha256").update(JSON.stringify(ids)).digest("hex");

export const readPiHistory = (input: {
  readonly threadId: ThreadId;
  readonly cursor: PiResumeCursor;
  readonly request: PiHistoryRequest;
}) =>
  Effect.gen(function* () {
    const error = (detail: string) => new PiRpcError({ operation: "history", detail });
    const initial = yield* input.request({ type: "get_state" });
    if (
      piRecordString(initial, "sessionFile") !== input.cursor.sessionFile ||
      piRecordField(initial, "isStreaming") !== false
    )
      return yield* error("Pi history changed sessions or is still running.");
    const tree = parsePiSessionTree(yield* input.request({ type: "get_entries" }));
    const branch = tree ? piActiveBranch(tree) : null;
    if (!tree || !branch) return yield* error("Pi history has incomplete or cyclic ancestry.");
    // get_messages is the active context; get_entries alone also contains abandoned branches.
    const data = yield* input.request({ type: "get_messages" });
    const messages = piRecordField(data, "messages");
    if (!Array.isArray(messages) || messages.length > 20_000)
      return yield* error("Pi did not return a bounded active message history.");
    const after = parsePiSessionTree(yield* input.request({ type: "get_entries" }));
    const afterBranch = after ? piActiveBranch(after) : null;
    const final = yield* input.request({ type: "get_state" });
    if (
      !after ||
      !afterBranch ||
      tree.leafId !== after.leafId ||
      branch.length !== afterBranch.length ||
      branch.some((entry, index) => entry.id !== afterBranch[index]?.id) ||
      piRecordString(final, "sessionFile") !== input.cursor.sessionFile ||
      piRecordField(final, "isStreaming") !== false
    )
      return yield* error("Pi history changed during the snapshot.");
    const users = branch.filter((entry) => entry.user).map((entry) => entry.id);
    const nativeUserCount = messages.filter(
      (message) => piRecordString(message, "role") === "user",
    ).length;
    if (nativeUserCount > users.length)
      return yield* error("Pi messages do not match their persisted branch boundaries.");
    const known = new Map(
      input.cursor.boundaries.map((boundary) => [boundary.entryId, boundary.turnId]),
    );
    const continuationIds = new Set(
      input.cursor.boundaries
        .filter((boundary) => boundary.kind === "continuation")
        .map((boundary) => boundary.entryId),
    );
    const turnEntryIds = branch
      .filter((entry) => entry.user || continuationIds.has(entry.id))
      .map((entry) => entry.id);
    const fingerprint = (message: unknown) =>
      stringifyWithinBytes(message, 16 * 1024 * 1024) === undefined
        ? undefined
        : canonicalJsonHash(message);
    const continuationByFingerprint = new Map<string, string>();
    for (const entry of branch) {
      if (!continuationIds.has(entry.id)) continue;
      const key = fingerprint(entry.message);
      if (!key || continuationByFingerprint.has(key))
        return yield* error("Pi continuation history has ambiguous native message boundaries.");
      continuationByFingerprint.set(key, entry.id);
    }
    // Native message identity must be unique before matching context messages to
    // assistant-only continuation boundaries. Identical text alone is insufficient.
    const counts = new Map<string, number>();
    for (const entry of branch) {
      if (!continuationByFingerprint.size || entry.message === undefined) continue;
      const key = fingerprint(entry.message);
      if (key && continuationByFingerprint.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if ([...continuationByFingerprint.keys()].some((key) => counts.get(key) !== 1))
      return yield* error("Pi continuation messages have no unique persisted identity.");
    const items = new Map(turnEntryIds.map((id) => [id, [] as unknown[]]));
    let userIndex = users.length - nativeUserCount - 1;
    let current = users[userIndex];
    const seenContinuations = new Set<string>();
    for (const [index, message] of messages.entries()) {
      const role = piRecordString(message, "role");
      if (role === "user") {
        userIndex++;
        current = users[userIndex];
      }
      const key = continuationByFingerprint.size ? fingerprint(message) : undefined;
      const continuation = key ? continuationByFingerprint.get(key) : undefined;
      if (continuation) {
        if (seenContinuations.has(continuation))
          return yield* error("Pi repeated a continuation history message.");
        seenContinuations.add(continuation);
        current = continuation;
      }
      if (role !== "user" && role !== "assistant") continue;
      if (!current) continue;
      items.get(current)!.push({
        id: `${current}:message:${index}`,
        type: role === "user" ? "userMessage" : "agentMessage",
        role,
        content: piRecordField(message, "content"),
      });
    }
    const snapshot: ProviderThreadSnapshot = {
      threadId: input.threadId,
      history: {
        identity: input.cursor.sessionFile,
        provenance: "provider-persisted",
        coverage: "complete",
        boundary: tree.leafId,
        runtimeId: null,
      },
      turns: turnEntryIds.map((id) => ({
        id: TurnId.make(known.get(id) ?? id),
        items: items.get(id)!,
      })),
    };
    return {
      snapshot,
      tree,
      userEntryIds: users,
      turnEntryIds,
      activeEntryIds: branch.map((entry) => entry.id),
    };
  });
