import { describe, expect, it } from "vitest";
import { acpFileChanges } from "./AcpFileChanges";

describe("acpFileChanges", () => {
  it("adds file boundaries to each v2 hunk, including additions and deletions", () => {
    const changes = acpFileChanges([
      {
        type: "diff",
        changes: [{ operation: "add", path: "/repo/a" }],
        patch: { text: "@@ -0,0 +1 @@\n+new\n" },
      },
      {
        type: "diff",
        changes: [{ operation: "delete", path: "/repo/b" }],
        patch: { text: "@@ -1 +0,0 @@\n-old\n" },
      },
    ]);
    expect(changes).toHaveLength(2);
    expect(changes[0]!.diff).toContain("--- /dev/null\n");
    expect(changes[1]!.diff).toContain("+++ /dev/null\n");
  });
  it("retains mixed patch and contents diffs in their original order", () => {
    expect(
      acpFileChanges([
        {
          type: "diff",
          changes: [{ operation: "modify", path: "/repo/a" }],
          patch: { text: "diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+A\n" },
        },
        { type: "diff", path: "/repo/b", oldText: "b", newText: "B" },
        { type: "diff", path: "/repo/c", oldText: null, newText: "C" },
      ]),
    ).toEqual([
      { path: "/repo/a", type: "update", diff: "diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+A\n" },
      { path: "/repo/b", type: "update", diff: "@@ -1,1 +1,1 @@\n-b\n+B" },
      { path: "/repo/c", type: "add", content: "C" },
    ]);
  });
});
