import {
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetTurnDiffInput,
  ThreadId,
} from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { Option, Schema } from "effect";
import { ensureNativeApi } from "../nativeApi";

interface CheckpointDiffQueryInput {
  threadId: ThreadId | null;
  fromTurnCount: number | null;
  toTurnCount: number | null;
  cacheScope?: string | null;
  enabled?: boolean;
  retryMode?: "panel" | "inline";
}

export const providerQueryKeys = {
  all: ["providers"] as const,
  checkpointDiffPrefix: (threadId: ThreadId | null) =>
    ["providers", "checkpointDiff", threadId] as const,
  checkpointDiff: (input: CheckpointDiffQueryInput) =>
    [
      "providers",
      "checkpointDiff",
      input.threadId,
      input.fromTurnCount,
      input.toTurnCount,
      input.cacheScope ?? null,
    ] as const,
  fileContent: (input: { cwd: string | undefined; relativePath: string | undefined }) =>
    ["fileContent", input.cwd, input.relativePath] as const,
};

function decodeCheckpointDiffRequest(input: CheckpointDiffQueryInput) {
  if (input.fromTurnCount === 0) {
    return Schema.decodeUnknownOption(OrchestrationGetFullThreadDiffInput)({
      threadId: input.threadId,
      toTurnCount: input.toTurnCount,
    }).pipe(Option.map((fields) => ({ kind: "fullThreadDiff" as const, input: fields })));
  }

  return Schema.decodeUnknownOption(OrchestrationGetTurnDiffInput)({
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
  }).pipe(Option.map((fields) => ({ kind: "turnDiff" as const, input: fields })));
}

function asCheckpointErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "";
}

function normalizeCheckpointErrorMessage(error: unknown): string {
  const message = asCheckpointErrorMessage(error).trim();
  if (message.length === 0) {
    return "Failed to load checkpoint diff.";
  }

  const lower = message.toLowerCase();
  if (lower.includes("not a git repository")) {
    return "Turn diffs are unavailable because this project is not a git repository.";
  }

  if (
    lower.includes("checkpoint unavailable for thread") ||
    lower.includes("checkpoint invariant violation")
  ) {
    const separatorIndex = message.indexOf(":");
    if (separatorIndex >= 0) {
      const detail = message.slice(separatorIndex + 1).trim();
      if (detail.length > 0) {
        return detail;
      }
    }
  }

  return message;
}

function isCheckpointTemporarilyUnavailable(error: unknown): boolean {
  const message = asCheckpointErrorMessage(error).toLowerCase();
  return (
    message.includes("exceeds current turn count") ||
    message.includes("checkpoint is unavailable for turn") ||
    message.includes("filesystem checkpoint is unavailable")
  );
}

export function checkpointDiffQueryOptions(input: CheckpointDiffQueryInput) {
  const decodedRequest = decodeCheckpointDiffRequest(input);
  const retryMode = input.retryMode ?? "panel";

  return queryOptions({
    queryKey: providerQueryKeys.checkpointDiff(input),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.threadId || decodedRequest._tag === "None") {
        throw new Error("Checkpoint diff is unavailable.");
      }
      try {
        if (decodedRequest.value.kind === "fullThreadDiff") {
          return await api.orchestration.getFullThreadDiff(decodedRequest.value.input);
        }
        return await api.orchestration.getTurnDiff(decodedRequest.value.input);
      } catch (error) {
        throw new Error(normalizeCheckpointErrorMessage(error), { cause: error });
      }
    },
    enabled: (input.enabled ?? true) && !!input.threadId && decodedRequest._tag === "Some",
    staleTime: Infinity,
    retry: (failureCount, error) => {
      if (retryMode === "inline") {
        return isCheckpointTemporarilyUnavailable(error) ? failureCount < 3 : false;
      }
      if (isCheckpointTemporarilyUnavailable(error)) {
        return failureCount < 12;
      }
      return failureCount < 3;
    },
    retryDelay: (attempt, error) =>
      isCheckpointTemporarilyUnavailable(error)
        ? Math.min(retryMode === "inline" ? 1_000 : 5_000, 250 * 2 ** (attempt - 1))
        : Math.min(1_000, 100 * 2 ** (attempt - 1)),
  });
}

export function fileContentQueryOptions(input: {
  cwd: string | undefined;
  relativePath: string | undefined;
}) {
  return queryOptions({
    queryKey: providerQueryKeys.fileContent(input),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd || !input.relativePath) {
        throw new Error("File path is unavailable.");
      }
      return await api.projects.readFile({ cwd: input.cwd, relativePath: input.relativePath });
    },
    enabled: !!input.cwd && !!input.relativePath,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
