import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { CommandId, OrchestrationCommandExecutionId, ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ThreadCommandExecutionQueryShape } from "../orchestration/Services/ThreadCommandExecutionQuery.ts";
import { truncateCommandTranscriptOutput } from "../orchestration/outputTruncation.ts";
import { extractTextContent } from "../provider/claudeToolPresentation.ts";
import { readCompleteLogLines } from "./completeLogLines.ts";

export interface ClaudeCommandOutputCandidate {
  readonly threadId: string;
  readonly turnId: string;
  readonly commandExecutionId: string;
  readonly providerItemId: string;
  readonly lastUpdatedSequence: number;
}

export interface ClaudeCommandOutputInspection {
  readonly candidate: ClaudeCommandOutputCandidate;
  readonly reason: "eligible" | "missing_history" | "ambiguous_history" | "empty_result";
  readonly output: string;
  readonly outputTruncated: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Read only this thread's retained logs, including rotations; never execute provider tools. */
export async function inspectClaudeCommandOutputs(input: {
  readonly candidates: ReadonlyArray<ClaudeCommandOutputCandidate>;
  readonly providerLogsDir: string;
}): Promise<ReadonlyArray<ClaudeCommandOutputInspection>> {
  const files = existsSync(input.providerLogsDir) ? readdirSync(input.providerLogsDir) : [];
  const byThread = new Map<string, ClaudeCommandOutputCandidate[]>();
  for (const candidate of input.candidates) {
    const entries = byThread.get(candidate.threadId) ?? [];
    entries.push(candidate);
    byThread.set(candidate.threadId, entries);
  }
  const inspections: ClaudeCommandOutputInspection[] = [];
  for (const [threadId, candidates] of byThread) {
    const byItem = new Map(candidates.map((candidate) => [candidate.providerItemId, candidate]));
    const starts = new Map<string, Set<string>>();
    const results = new Map<string, Set<string>>();
    for (const file of files.filter(
      (name) => name === `${threadId}.log` || name.startsWith(`${threadId}.log.`),
    )) {
      for await (const line of readCompleteLogLines(path.join(input.providerLogsDir, file))) {
        const marker = line.indexOf("] NTIVE: ");
        if (marker < 0) continue;
        let event: Record<string, unknown> | undefined;
        try {
          const parsed = record(JSON.parse(line.slice(marker + "] NTIVE: ".length)));
          event = record(parsed?.event) ?? parsed;
        } catch {
          continue;
        }
        if (event?.provider !== "claudeAgent") continue;
        const message = record(event.payload);
        if (!message || message.parent_tool_use_id != null) continue;
        const sessionId = message.session_id;
        if (typeof sessionId !== "string" || !sessionId) continue;
        const content = record(message.message)?.content;
        const streamBlock = record(record(message.event)?.content_block);
        const blocks = Array.isArray(content) ? content : streamBlock ? [streamBlock] : [];
        for (const value of blocks) {
          const block = record(value);
          if (!block) continue;
          const itemId = block.id ?? block.tool_use_id;
          const candidate = typeof itemId === "string" ? byItem.get(itemId) : undefined;
          if (!candidate) continue;
          if (
            block.type === "tool_use" &&
            block.name === "Bash" &&
            event.turnId === candidate.turnId
          ) {
            const sessions = starts.get(candidate.providerItemId) ?? new Set<string>();
            sessions.add(sessionId);
            starts.set(candidate.providerItemId, sessions);
          }
          if (message.type !== "user" || block.type !== "tool_result") continue;
          const structured = record(message.tool_use_result);
          // A background launch acknowledgement is not the command's final output.
          if (structured?.backgroundTaskId || structured?.background_task_id) continue;
          const text = extractTextContent(block.content);
          if (/\bbackground(?:\s+task)?(?:\s+with)?\s+id:/i.test(text)) continue;
          const key = `${candidate.providerItemId}:${sessionId}`;
          const outputs = results.get(key) ?? new Set<string>();
          outputs.add(text);
          results.set(key, outputs);
        }
      }
    }
    for (const candidate of candidates) {
      const sessions = starts.get(candidate.providerItemId);
      const outputs =
        sessions?.size === 1
          ? results.get(`${candidate.providerItemId}:${[...sessions][0]}`)
          : undefined;
      const output = outputs?.size === 1 ? [...outputs][0]! : "";
      inspections.push({
        candidate,
        reason:
          (sessions?.size ?? 0) > 1 || (outputs?.size ?? 0) > 1
            ? "ambiguous_history"
            : !outputs
              ? "missing_history"
              : output.length === 0
                ? "empty_result"
                : "eligible",
        ...truncateCommandTranscriptOutput(output),
      });
    }
  }
  return inspections;
}

export const repairClaudeCommandOutput = Effect.fn(function* (input: {
  readonly inspection: ClaudeCommandOutputInspection;
  readonly engine: Pick<OrchestrationEngineShape, "dispatch">;
  readonly query: Pick<ThreadCommandExecutionQueryShape, "getThreadCommandExecution">;
  readonly apply: boolean;
}) {
  const { inspection } = input;
  if (inspection.reason !== "eligible") return inspection.reason;
  if (!input.apply) return "dry-run";
  const { candidate } = inspection;
  const threadId = ThreadId.makeUnsafe(candidate.threadId);
  const commandExecutionId = OrchestrationCommandExecutionId.makeUnsafe(
    candidate.commandExecutionId,
  );
  const { commandExecution: current } = yield* input.query.getThreadCommandExecution({
    threadId,
    commandExecutionId,
  });
  if (
    !current ||
    current.output.length > 0 ||
    current.outputTruncated ||
    current.turnId !== candidate.turnId ||
    current.providerItemId !== candidate.providerItemId ||
    current.lastUpdatedSequence !== candidate.lastUpdatedSequence
  )
    return "changed";
  const { sequence } = yield* input.engine.dispatch({
    type: "thread.command-execution.output.reconcile",
    commandId: CommandId.makeUnsafe(
      `repair:claude-command-output:${commandExecutionId}:${candidate.lastUpdatedSequence}`,
    ),
    threadId,
    commandExecutionId,
    expectedLastUpdatedSequence: candidate.lastUpdatedSequence,
    output: inspection.output,
    outputTruncated: inspection.outputTruncated,
    updatedAt: current.updatedAt,
    createdAt: new Date().toISOString(),
  });
  const verified = yield* input.query.getThreadCommandExecution({ threadId, commandExecutionId });
  return verified.commandExecution?.lastUpdatedSequence === sequence &&
    verified.commandExecution.output === inspection.output &&
    verified.commandExecution.outputTruncated === inspection.outputTruncated
    ? "repaired"
    : "changed";
});
