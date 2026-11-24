import { describe, expect, it } from "vitest";
import { makeAntigravityToolNormalizer } from "./AntigravityToolCalls.ts";
import { acpFileChanges } from "./AcpFileChanges.ts";

describe("Antigravity native tools", () => {
  it("locates native replacement hunks and never presents unknown snippets as whole files", () => {
    const normalize = makeAntigravityToolNormalizer(
      () => Array(19).fill("line").join("\n") + "\nold",
    );
    const tool = normalize({
      toolCallId: "edit-1",
      title: "Running replace_file_content",
      kind: "other",
      status: "pending",
      data: {
        rawInput: { TargetContent: "old", ReplacementContent: "new", StartLine: 20, EndLine: 20 },
        content: [{ type: "diff", path: "/missing/file.ts", oldText: "old", newText: "new" }],
      },
    });
    expect(tool.kind).toBe("edit");
    expect(acpFileChanges(tool.data.content)[0]?.diff).toContain("@@ -20,1 +20,1 @@");
    const unknown = makeAntigravityToolNormalizer(() => undefined)({
      ...tool,
      toolCallId: "edit-2",
      data: {
        rawInput: { TargetContent: "old", ReplacementContent: "new" },
        content: [{ type: "diff", path: "/missing/file.ts", oldText: "old", newText: "new" }],
      },
    });
    expect(acpFileChanges(unknown.data.content)).toEqual([]);
  });

  it("uses Antigravity's tool summary as the command description", () => {
    const normalize = makeAntigravityToolNormalizer(() => undefined);
    const tool = normalize({
      toolCallId: "cmd-1",
      title: "ls -la",
      kind: "execute",
      status: "in_progress" as never,
      data: { rawInput: { CommandLine: "ls -la", toolSummary: "  Inspect top-level layout " } },
    });
    expect(tool.data.command).toBe("ls -la");
    expect(tool.data.input).toEqual({ description: "Inspect top-level layout" });

    const kept = normalize({
      toolCallId: "cmd-2",
      kind: "execute",
      data: {
        input: { description: "Existing" },
        rawInput: { CommandLine: "pwd", toolSummary: "Print directory" },
      },
    });
    expect(kept.data.input).toEqual({ description: "Existing" });

    // Other tools keep their own titles: a subagent's `input.description` names the task.
    const subagent = normalize({
      toolCallId: "agent-1",
      title: "start_subagent",
      kind: "other",
      data: { rawInput: { Prompt: "Audit", toolSummary: "Start an audit subagent" } },
    });
    expect(subagent.data.input).toBeUndefined();
  });

  it("shows writes into the brain directory as artifacts, not file changes", () => {
    const brain = "/profile/antigravity-acp/brain";
    const normalize = makeAntigravityToolNormalizer(undefined, [brain]);
    const artifact = (path: string, requestFeedback: boolean) =>
      normalize({
        toolCallId: "artifact-1",
        title: "File plan.md",
        kind: "edit",
        status: "completed",
        data: {
          rawInput: {
            Path: path,
            Content: "# Plan\n".repeat(5_000),
            ArtifactMetadata: { RequestFeedback: requestFeedback, Summary: "The plan" },
          },
          locations: [{ path }],
          content: [{ type: "diff", path, oldText: null, newText: "# Plan" }],
        },
      });
    const plan = artifact(`${brain}/conv-1/implementation_plan.md`, true);
    expect(plan.kind).toBe("other");
    expect(plan.title).toBe("Updated plan artifact implementation_plan.md");
    expect(plan.data).toEqual({
      rawInput: { Path: `${brain}/conv-1/implementation_plan.md`, summary: "The plan" },
    });
    expect(acpFileChanges(plan.data.content)).toEqual([]);
    expect(artifact(`${brain}/conv-1/task.md`, false).title).toBe("Updated artifact task.md");
    // Outside the brain directory an edit stays an edit.
    const workspace = artifact("/workspace/plan.md", true);
    expect(workspace.kind).toBe("edit");
    expect(workspace.title).toBe("File plan.md");
  });
});
