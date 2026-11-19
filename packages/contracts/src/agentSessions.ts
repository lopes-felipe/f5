import { Schema } from "effect";
import {
  IsoDateTime,
  FilesystemPath,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";

export const AgentSessionSource = Schema.Literals(["codex", "claudeAgent"]);
export type AgentSessionSource = typeof AgentSessionSource.Type;
export const AgentSessionProjectCandidate = Schema.Struct({
  id: TrimmedNonEmptyString,
  path: FilesystemPath,
  title: TrimmedNonEmptyString,
  sources: Schema.Array(AgentSessionSource),
  threadCount: NonNegativeInt,
  lastActiveAt: IsoDateTime,
  alreadyImported: Schema.Boolean,
});
export type AgentSessionProjectCandidate = typeof AgentSessionProjectCandidate.Type;
export const AgentSessionScanResult = Schema.Struct({
  candidates: Schema.Array(AgentSessionProjectCandidate),
  scannedAt: IsoDateTime,
  truncated: Schema.Boolean,
});
export type AgentSessionScanResult = typeof AgentSessionScanResult.Type;
export const AgentSessionImportInput = Schema.Struct({
  candidateId: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  expectedWorkspaceRoot: FilesystemPath,
  includeHistory: Schema.Boolean,
  continuation: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(160))),
});
export type AgentSessionImportInput = typeof AgentSessionImportInput.Type;
export const AgentSessionImportResult = Schema.Struct({
  projectId: ProjectId,
  threadIds: Schema.Array(ThreadId),
  skippedCount: NonNegativeInt,
  truncated: Schema.Boolean,
  continuation: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(160))),
});
export type AgentSessionImportResult = typeof AgentSessionImportResult.Type;
export const IMPORTED_SESSION_MESSAGE_MAX_CHARS = 64 * 1024;
export const IMPORTED_SESSION_THREAD_MAX_CHARS = 512 * 1024;
export const ImportedSessionMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String.check(Schema.isMaxLength(IMPORTED_SESSION_MESSAGE_MAX_CHARS)),
  createdAt: IsoDateTime,
});
export type ImportedSessionMessage = typeof ImportedSessionMessage.Type;
export const ImportedSessionMessages = Schema.Array(ImportedSessionMessage).check(
  Schema.isMaxLength(200),
  Schema.makeFilter(
    (messages) =>
      messages.reduce((total, message) => total + message.text.length, 0) <=
        IMPORTED_SESSION_THREAD_MAX_CHARS || "Imported thread history exceeds the text limit.",
  ),
);
