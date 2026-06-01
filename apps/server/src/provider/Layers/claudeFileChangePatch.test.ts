import { describe, expect, it } from "vitest";

import {
  buildClaudeFileChangeStructuredChanges,
  buildClaudeReplaceHunk,
} from "./claudeFileChangePatch.ts";

describe("buildClaudeReplaceHunk", () => {
  it("emits a replace hunk with removed and added lines", () => {
    const hunk = buildClaudeReplaceHunk("old line", "new line");
    expect(hunk).toBe("@@ -1,1 +1,1 @@\n-old line\n+new line");
  });

  it("uses 0,0 ranges for pure insertions and deletions", () => {
    expect(buildClaudeReplaceHunk("", "added")).toBe("@@ -0,0 +1,1 @@\n+added");
    expect(buildClaudeReplaceHunk("removed", "")).toBe("@@ -1,1 +0,0 @@\n-removed");
  });

  it("handles multi-line old/new content", () => {
    const hunk = buildClaudeReplaceHunk("a\nb", "a\nc\nd");
    expect(hunk).toBe("@@ -1,2 +1,3 @@\n-a\n-b\n+a\n+c\n+d");
  });
});

describe("buildClaudeFileChangeStructuredChanges", () => {
  it("treats Write as an add with the full content", () => {
    const changes = buildClaudeFileChangeStructuredChanges("Write", {
      file_path: "/repo/scratch.txt",
      content: "hello\nworld",
    });
    expect(changes).toEqual([{ path: "/repo/scratch.txt", type: "add", content: "hello\nworld" }]);
  });

  it("treats Edit as an update with a replace hunk", () => {
    const changes = buildClaudeFileChangeStructuredChanges("Edit", {
      file_path: "/repo/file.ts",
      old_string: "const a = 1;",
      new_string: "const a = 2;",
    });
    expect(changes).toEqual([
      {
        path: "/repo/file.ts",
        type: "update",
        diff: "@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;",
      },
    ]);
  });

  it("concatenates hunks for MultiEdit", () => {
    const changes = buildClaudeFileChangeStructuredChanges("MultiEdit", {
      file_path: "/repo/file.ts",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c", new_string: "d" },
      ],
    });
    expect(changes).toHaveLength(1);
    expect(changes?.[0]?.type).toBe("update");
    expect(changes?.[0]?.diff).toBe("@@ -1,1 +1,1 @@\n-a\n+b\n@@ -1,1 +1,1 @@\n-c\n+d");
  });

  it("supports NotebookEdit source fields and notebook_path", () => {
    const changes = buildClaudeFileChangeStructuredChanges("NotebookEdit", {
      notebook_path: "/repo/nb.ipynb",
      old_source: "print(1)",
      new_source: "print(2)",
    });
    expect(changes).toEqual([
      {
        path: "/repo/nb.ipynb",
        type: "update",
        diff: "@@ -1,1 +1,1 @@\n-print(1)\n+print(2)",
      },
    ]);
  });

  it("returns undefined without a usable file path", () => {
    expect(buildClaudeFileChangeStructuredChanges("Write", { content: "x" })).toBeUndefined();
  });

  it("returns undefined for non-file-editing tools", () => {
    expect(
      buildClaudeFileChangeStructuredChanges("Bash", { command: "ls", file_path: "/repo/x" }),
    ).toBeUndefined();
  });

  it("returns undefined for an Edit with no content change", () => {
    expect(
      buildClaudeFileChangeStructuredChanges("Edit", {
        file_path: "/repo/file.ts",
        old_string: "",
        new_string: "",
      }),
    ).toBeUndefined();
  });
});
