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
});
