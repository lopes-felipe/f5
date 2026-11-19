import { Schema } from "effect";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";

export const AgentSessionSource = Schema.Literals(["codex", "claudeAgent"]);
export type AgentSessionSource = typeof AgentSessionSource.Type;
export const AgentSessionProjectCandidate = Schema.Struct({
  id: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
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
  expectedWorkspaceRoot: TrimmedNonEmptyString,
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
export const ImportedSessionMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  createdAt: IsoDateTime,
});
export type ImportedSessionMessage = typeof ImportedSessionMessage.Type;
