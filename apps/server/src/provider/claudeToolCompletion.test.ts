import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildClaudeToolCompletion,
  claudeSubagentTaskToolOutput,
  isClaudeTaskToolName,
  readClaudeToolNonExecutionKind,
  storeClaudeToolCompletionArtifact,
} from "./claudeToolCompletion.ts";

const base = {
  toolUseId: "toolu_1",
  toolInput: { taskId: "1" },
  correlated: true,
  isError: false,
  nativeSessionId: "session-1",
};

describe("buildClaudeToolCompletion", () => {
  it("distinguishes Task CRUD tools from the legacy Task delegation tool", () => {
    expect(isClaudeTaskToolName("TaskCreate")).toBe(true);
    expect(isClaudeTaskToolName("Task")).toBe(false);
    expect(isClaudeTaskToolName("TodoWrite")).toBe(false);
  });

  it("retains Task outputs and inputs inline", () => {
    const { envelope, oversizeOutput } = buildClaudeToolCompletion({
      ...base,
      toolName: "TaskGet",
      structuredOutput: { task: null },
    });
    expect(oversizeOutput).toBeUndefined();
    expect(envelope).toEqual({
      version: 1,
      nativeCallId: "toolu_1",
      nativeSessionId: "session-1",
      toolName: "TaskGet",
      input: { taskId: "1" },
      structuredOutput: { task: null },
      transportError: false,
      semanticSuccess: true,
    });
  });

  it("does not persist outputs of tools F5 does not consume", () => {
    const { envelope } = buildClaudeToolCompletion({
      ...base,
      toolName: "Read",
      toolInput: { file_path: "/a" },
      structuredOutput: { type: "text", file: { content: "x".repeat(10) } },
    });
    expect(envelope.structuredOutput).toBeUndefined();
    expect(envelope.input).toBeUndefined();
    expect(envelope.outputOmission?.reason).toBe("not-retained");
    expect(envelope.outputOmission?.bytes).toBeGreaterThan(0);
  });

  it("reports semantic failures and transport errors separately", () => {
    const semantic = buildClaudeToolCompletion({
      ...base,
      toolName: "TaskUpdate",
      structuredOutput: { success: false, taskId: "1", updatedFields: [] },
    }).envelope;
    expect(semantic).toMatchObject({ transportError: false, semanticSuccess: false });
    expect(semantic.semanticError).toBeUndefined();
    const transport = buildClaudeToolCompletion({
      ...base,
      toolName: "TaskUpdate",
      isError: true,
      structuredOutput: undefined,
    }).envelope;
    expect(transport).toMatchObject({ transportError: true, semanticSuccess: false });
    // Other tools' `success` fields are not a failure contract.
    const other = buildClaudeToolCompletion({
      ...base,
      toolName: "WebFetch",
      structuredOutput: { success: false },
    }).envelope;
    expect(other).toMatchObject({ transportError: false, semanticSuccess: true });
  });

  it("refuses to attribute an output shared by several tool results", () => {
    const { envelope } = buildClaudeToolCompletion({
      ...base,
      toolName: "TaskCreate",
      correlated: false,
      structuredOutput: { success: false, task: { id: "1", subject: "x" } },
    });
    expect(envelope.structuredOutput).toBeUndefined();
    expect(envelope.outputOmission).toEqual({ reason: "uncorrelated" });
    // An unattributable payload cannot fail the call either.
    expect(envelope.semanticSuccess).toBe(true);
  });

  it("bounds inputs and outputs and flags unserializable values", () => {
    const large = buildClaudeToolCompletion({
      ...base,
      toolName: "TaskList",
      toolInput: { blob: "y".repeat(20 * 1024) },
      structuredOutput: { tasks: [{ id: "1", subject: "z".repeat(70 * 1024) }] },
    });
    expect(large.envelope.input).toBeUndefined();
    expect(large.envelope.inputOmission?.reason).toBe("too-large");
    expect(large.envelope.structuredOutput).toBeUndefined();
    expect(large.envelope.outputOmission).toMatchObject({ reason: "too-large" });
    expect(large.envelope.outputOmission?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(large.oversizeOutput?.bytes).toBeGreaterThan(64 * 1024);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      buildClaudeToolCompletion({ ...base, toolName: "TaskList", structuredOutput: cyclic })
        .envelope.outputOmission,
    ).toEqual({ reason: "unserializable" });
  });
});

describe("claudeSubagentTaskToolOutput", () => {
  it("rebuilds structured results from subagent text", () => {
    expect(
      claudeSubagentTaskToolOutput("TaskCreate", "Task #3 created successfully: Run tests\n"),
    ).toEqual({ task: { id: "3", subject: "Run tests" } });
    expect(claudeSubagentTaskToolOutput("TaskUpdate", "Updated task #3 status")).toEqual({
      success: true,
      taskId: "3",
    });
  });

  it("reads the non-execution kind of one result and fails Task calls that never ran", () => {
    const message = {
      tool_result_meta: [
        { id: "other", non_execution_kind: "skipped" },
        { id: "toolu_1", non_execution_kind: "cancelled" },
      ],
    };
    expect(readClaudeToolNonExecutionKind(message, "toolu_1")).toBe("cancelled");
    expect(readClaudeToolNonExecutionKind(message, "missing")).toBeUndefined();
    expect(readClaudeToolNonExecutionKind({}, "toolu_1")).toBeUndefined();
    expect(
      readClaudeToolNonExecutionKind(
        { tool_result_meta: [{ id: "toolu_1", non_execution_kind: null }] },
        "toolu_1",
      ),
    ).toBeUndefined();
    const { envelope } = buildClaudeToolCompletion({
      ...base,
      toolName: "TaskUpdate",
      structuredOutput: { success: true, taskId: "1" },
      nonExecutionKind: "cancelled",
    });
    expect(envelope.semanticSuccess).toBe(false);
    expect(envelope.transportError).toBe(false);
    // Non-Task tools keep the transport-level status.
    expect(
      buildClaudeToolCompletion({
        ...base,
        toolName: "Read",
        structuredOutput: undefined,
        nonExecutionKind: "cancelled",
      }).envelope.semanticSuccess,
    ).toBe(true);
  });

  it("treats any other text as a failed call", () => {
    expect(claudeSubagentTaskToolOutput("TaskUpdate", "Task #9 not found")).toEqual({
      success: false,
      error: "Task #9 not found",
    });
    expect(claudeSubagentTaskToolOutput("TaskCreate", "")).toEqual({ success: false });
    const failed = buildClaudeToolCompletion({
      ...base,
      toolName: "TaskUpdate",
      structuredOutput: claudeSubagentTaskToolOutput("TaskUpdate", "Task #9 not found"),
    });
    expect(failed.envelope.semanticSuccess).toBe(false);
    expect(failed.envelope.semanticError).toBe("Task #9 not found");
  });
});

describe("storeClaudeToolCompletionArtifact", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.map((directory) => NodeFs.rm(directory, { recursive: true, force: true })),
    );
  });

  it("stores oversize output as a thread-scoped JSON attachment", async () => {
    const attachmentsDir = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "f5-tool-out-"));
    directories.push(attachmentsDir);
    const draft = buildClaudeToolCompletion({
      ...base,
      toolName: "TaskList",
      structuredOutput: { tasks: [{ id: "1", subject: "z".repeat(70 * 1024) }] },
    });
    const envelope = await storeClaudeToolCompletionArtifact({
      attachmentsDir,
      threadId: "Thread-ABC",
      draft,
    });
    const artifact = envelope.outputOmission?.artifact;
    expect(artifact?.kind).toBe("attachment");
    expect(artifact?.attachmentId).toMatch(/^thread-abc-[0-9a-f-]{36}$/);
    const stored = await NodeFs.readFile(
      NodePath.join(attachmentsDir, `${artifact?.attachmentId}.json`),
      "utf8",
    );
    expect(JSON.parse(stored)).toEqual({ tasks: [{ id: "1", subject: "z".repeat(70 * 1024) }] });
  });
});
