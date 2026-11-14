import { describe, expect, it } from "vitest";
import { acpFileChanges } from "./AcpFileChanges";
import { parsePatchFiles } from "@pierre/diffs";

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
    expect(
      parsePatchFiles(changes.map((change) => change.diff).join("\n")).flatMap(
        (patch) => patch.files,
      ),
    ).toHaveLength(2);
  });
  it("renders a one-line edit in a 2,000-line file as one deletion and addition", () => {
    const lines = Array.from({ length: 2_000 }, (_, i) => "line " + i + "\n");
    const changed = [...lines];
    changed[1_000] = "edited\n";
    const [change] = acpFileChanges([
      { type: "diff", path: "/repo/large.ts", oldText: lines.join(""), newText: changed.join("") },
    ]);
    const files = parsePatchFiles(String(change!.diff)).flatMap((patch) => patch.files);
    expect(files).toHaveLength(1);
    expect(
      String(change!.diff)
        .split("\n")
        .filter((line) => line.startsWith("+") && !line.startsWith("+++")),
    ).toHaveLength(1);
    expect(
      String(change!.diff)
        .split("\n")
        .filter((line) => line.startsWith("-") && !line.startsWith("---")),
    ).toHaveLength(1);
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
      {
        path: "/repo/b",
        type: "update",
        diff: expect.stringContaining("-b\n\\ No newline at end of file\n+B"),
      },
      { path: "/repo/c", type: "add", content: "C" },
    ]);
  });
});
