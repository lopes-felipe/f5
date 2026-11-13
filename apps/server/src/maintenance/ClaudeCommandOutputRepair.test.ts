import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OrchestrationCommandExecutionId,
  ProviderItemId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationCommandExecution,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import {
  inspectClaudeCommandOutputs,
  repairClaudeCommandOutput,
  type ClaudeCommandOutputCandidate,
} from "./ClaudeCommandOutputRepair.ts";
import { MAX_COMMAND_TRANSCRIPT_BYTES } from "../orchestration/outputTruncation.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const candidate: ClaudeCommandOutputCandidate = {
  threadId: "thread-repair",
  turnId: "turn-repair",
  commandExecutionId: "command-repair",
  providerItemId: "tool-repair",
  lastUpdatedSequence: 3,
};
function nativeLine(
  content: unknown,
  options: { session?: string; turn?: string; type?: string } = {},
) {
  return `[2026-11-13T13:00:00.000Z] NTIVE: ${JSON.stringify({
    event: {
      provider: "claudeAgent",
      turnId: options.turn ?? candidate.turnId,
      payload: {
        type: options.type ?? "user",
        session_id: options.session ?? "native-session",
        parent_tool_use_id: null,
        message: { content },
      },
    },
  })}\n`;
}
const start = () =>
  nativeLine(
    [
      {
        type: "tool_use",
        id: candidate.providerItemId,
        name: "Bash",
        input: { command: "pwd" },
      },
    ],
    { type: "assistant" },
  );
const result = (text: string, options = {}) =>
  nativeLine(
    [
      {
        type: "tool_result",
        tool_use_id: candidate.providerItemId,
        content: text,
      },
    ],
    options,
  );
async function inspect(lines: string, rotation?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f5-command-output-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, `${candidate.threadId}.log`), lines);
  if (rotation) fs.writeFileSync(path.join(dir, `${candidate.threadId}.log.1`), rotation);
  return (await inspectClaudeCommandOutputs({ candidates: [candidate], providerLogsDir: dir }))[0]!;
}

it("recovers exact text across rotations and deduplicates identical results", async () => {
  const text = "stdout\nstderr\n";
  const inspection = await inspect(result(text) + result(text), start());
  expect(inspection).toMatchObject({ reason: "eligible", output: text, outputTruncated: false });
});
it("requires a matching tool start in the original turn and native session", async () => {
  expect((await inspect(start() + result("wrong", { session: "other" }))).reason).toBe(
    "missing_history",
  );
  expect((await inspect(result("no start"))).reason).toBe("missing_history");
  expect((await inspect(start() + result("late", { turn: "next-turn" }))).output).toBe("late");
});
it("reports missing, conflicting and empty history, and ignores incomplete log tails", async () => {
  expect((await inspect("")).reason).toBe("missing_history");
  expect((await inspect(start() + result("one") + result("two"))).reason).toBe("ambiguous_history");
  expect((await inspect(start() + result(""))).reason).toBe("empty_result");
  expect((await inspect(start() + result("partial").trimEnd())).reason).toBe("missing_history");
});
it("applies the existing transcript retention limit", async () => {
  const inspection = await inspect(start() + result("x".repeat(MAX_COMMAND_TRANSCRIPT_BYTES * 2)));
  expect(inspection.outputTruncated).toBe(true);
  expect(Buffer.byteLength(inspection.output)).toBeLessThanOrEqual(MAX_COMMAND_TRANSCRIPT_BYTES);
});
it("defaults to dry-run, repairs once, and refuses concurrent changes", async () => {
  const inspection = await inspect(start() + result("recovered\n"));
  let current: OrchestrationCommandExecution = {
    id: OrchestrationCommandExecutionId.makeUnsafe(candidate.commandExecutionId),
    threadId: ThreadId.makeUnsafe(candidate.threadId),
    turnId: TurnId.makeUnsafe(candidate.turnId),
    providerItemId: ProviderItemId.makeUnsafe(candidate.providerItemId),
    command: "pwd",
    title: null,
    detail: null,
    status: "completed",
    exitCode: 0,
    output: "",
    outputTruncated: false,
    startedSequence: 1,
    lastUpdatedSequence: 3,
    startedAt: "2026-11-13T13:00:00.000Z",
    completedAt: "2026-11-13T13:00:01.000Z",
    updatedAt: "2026-11-13T13:00:01.000Z",
  };
  const query = { getThreadCommandExecution: () => Effect.succeed({ commandExecution: current }) };
  const dispatch = vi.fn((command: OrchestrationCommand) =>
    Effect.sync(() => {
      expect(command.type).toBe("thread.command-execution.output.reconcile");
      if (command.type === "thread.command-execution.output.reconcile") {
        expect(command.expectedLastUpdatedSequence).toBe(3);
        current = { ...current, output: command.output, lastUpdatedSequence: 4 };
      }
      return { sequence: 4 };
    }),
  );
  const run = (apply: boolean) =>
    Effect.runPromise(
      repairClaudeCommandOutput({
        inspection,
        query,
        engine: { dispatch },
        apply,
      }),
    );
  expect(await run(false)).toBe("dry-run");
  expect(dispatch).not.toHaveBeenCalled();
  expect(await run(true)).toBe("repaired");
  expect(await run(true)).toBe("changed");
  expect(dispatch).toHaveBeenCalledTimes(1);
  current = { ...current, output: "", lastUpdatedSequence: 5 };
  expect(await run(true)).toBe("changed");
  expect(dispatch).toHaveBeenCalledTimes(1);
});
