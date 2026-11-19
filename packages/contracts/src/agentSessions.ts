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
});
export type AgentSessionImportInput = typeof AgentSessionImportInput.Type;
export const AgentSessionImportResult = Schema.Struct({
  projectId: ProjectId,
  threadIds: Schema.Array(ThreadId),
  skippedCount: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type AgentSessionImportResult = typeof AgentSessionImportResult.Type;
export const MAX_IMPORTED_SESSION_MESSAGES = 200;
export const MAX_IMPORTED_SESSION_MESSAGE_CHARS = 32_000;
export const MAX_IMPORTED_SESSION_TEXT_CHARS = 256_000;
export const ImportedSessionMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String.check(Schema.isMaxLength(MAX_IMPORTED_SESSION_MESSAGE_CHARS)),
  createdAt: IsoDateTime,
});
export type ImportedSessionMessage = typeof ImportedSessionMessage.Type;
export const ImportedSessionMessages = Schema.Array(ImportedSessionMessage).check(
  Schema.isMaxLength(MAX_IMPORTED_SESSION_MESSAGES),
  Schema.makeFilter(
    (messages) =>
      messages.reduce((length, message) => length + message.text.length, 0) <=
        MAX_IMPORTED_SESSION_TEXT_CHARS || "Imported messages exceed the thread text limit.",
  ),
);
