import * as NodePath from "node:path";

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
    // An unplaced snippet is never shown as a whole file, but the row still names the file.
    expect(acpFileChanges(unknown.data.content)).toEqual([
      { path: "/missing/file.ts", type: "update" },
    ]);
  });

  it("decodes the short Target/Replacement argument names on the snippet path", () => {
    const tool = makeAntigravityToolNormalizer(() => Array(19).fill("line").join("\n") + "\nold")({
      toolCallId: "edit-short",
      title: "Running replace_file_content",
      kind: "other",
      status: "pending",
      data: {
        rawInput: { Path: "/repo/file.ts", Target: "old", Replacement: "new", StartLine: 20 },
        content: [{ type: "diff", path: "/repo/file.ts", oldText: "old", newText: "new" }],
      },
    });
    expect(acpFileChanges(tool.data.content)[0]?.diff).toContain("@@ -20,1 +20,1 @@");
  });

  it("diffs the full before/after texts current releases send on completion", () => {
    // Over 8000 characters, so a diff of sanitized (cut) texts would be wrong.
    const lines = Array.from({ length: 1_000 }, (_, index) => `const value${index} = ${index};\n`);
    const before = lines.join("");
    const after = lines.map((line, index) => (index === 700 ? "const edited = true;\n" : line));
    const normalize = makeAntigravityToolNormalizer(() => undefined);
    const tool = normalize({
      toolCallId: "edit-full",
      title: "File apps/web/src/file.ts",
      kind: "edit",
      status: "completed",
      data: {
        rawInput: {
          Path: "/repo/file.ts",
          Target: "const value700 = 700;\n",
          Replacement: "const edited = true;\n",
        },
        locations: [{ path: "/repo/file.ts" }],
        content: [
          { type: "diff", path: "/repo/file.ts", oldText: before, newText: after.join("") },
        ],
      },
    });
    const [entry] = tool.data.content as ReadonlyArray<Record<string, unknown>>;
    expect(entry).not.toHaveProperty("oldText");
    expect(entry).not.toHaveProperty("newText");
    const [change] = acpFileChanges(tool.data.content);
    expect(change?.path).toBe("/repo/file.ts");
    expect(change?.diff).toContain("@@ -698,7 +698,7 @@");
    expect(change?.diff).toContain("-const value700 = 700;\n+const edited = true;\n");

    // An unchanged file yields no change at all.
    const same = normalize({
      ...tool,
      toolCallId: "edit-same",
      data: {
        content: [{ type: "diff", path: "/repo/file.ts", oldText: before, newText: before }],
      },
    });
    expect(acpFileChanges(same.data.content)).toEqual([]);
  });

  it("shows a new-file write as an addition and an overwrite as a path-only change", () => {
    const normalize = makeAntigravityToolNormalizer(() => undefined);
    const write = (toolCallId: string, overwrite: boolean | undefined) =>
      normalize({
        toolCallId,
        title: "File src/new.ts",
        kind: "edit",
        status: "completed",
        data: {
          rawInput: {
            Path: "/repo/src/new.ts",
            Content: "export const a = 1;\n",
            ...(overwrite === undefined ? {} : { Overwrite: overwrite }),
          },
          content: [{ type: "diff", path: "/repo/src/new.ts", newText: "export const a = 1;\n" }],
        },
      });
    const [added] = acpFileChanges(write("write-new", undefined).data.content);
    expect(added?.diff).toContain("--- /dev/null\n+++ b//repo/src/new.ts\n@@ -0,0 +1,1 @@");
    expect(acpFileChanges(write("write-over", true).data.content)).toEqual([
      { path: "/repo/src/new.ts", type: "update" },
    ]);
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
    const brain = NodePath.resolve("/profile/antigravity-acp/brain");
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
    const planPath = NodePath.join(brain, "conv-1", "implementation_plan.md");
    const plan = artifact(planPath, true);
    expect(plan.kind).toBe("other");
    expect(plan.title).toBe("Updated plan artifact implementation_plan.md");
    expect(plan.data).toEqual({
      rawInput: { Path: planPath, summary: "The plan" },
    });
    expect(acpFileChanges(plan.data.content)).toEqual([]);
    expect(artifact(NodePath.join(brain, "conv-1", "task.md"), false).title).toBe(
      "Updated artifact task.md",
    );
    // Outside the brain directory an edit stays an edit.
    const workspace = artifact("/workspace/plan.md", true);
    expect(workspace.kind).toBe("edit");
    expect(workspace.title).toBe("File plan.md");

    // Reading a brain file stays a read, with its output.
    const read = normalize({
      toolCallId: "read-1",
      title: "Running view_file",
      kind: "other",
      status: "completed",
      data: {
        rawInput: { Path: NodePath.join(brain, "conv-1", "task.md") },
        rawOutput: { output: "- [ ] step" },
      },
    });
    expect(read.kind).toBe("read");
    expect(read.data.rawOutput).toEqual({ output: "- [ ] step" });
  });
});
