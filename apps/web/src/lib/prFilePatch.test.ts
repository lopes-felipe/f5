import { describe, expect, it } from "vitest";
import type { PrHubChangedFile } from "@t3tools/contracts";
import { getRenderablePrFilePatch } from "./prFilePatch";
import { isPrReviewAnchorInPatch } from "@t3tools/shared/prReview";

describe("GitHub PR patch rendering", () => {
  it.each(["src/file.ts", "space name.ts", 'quote"name.ts', "???.ts", "tab\tname.ts"])(
    "renders server-normalized patches for %s without changing anchors",
    (path) => {
      const file = fileFixture({
        filename: path,
        previous_filename: "old name.ts",
        sha: "blob",
        status: "renamed",
        additions: 1,
        deletions: 1,
        patch: "@@ -5 +5 @@\n-old\n+new",
      });
      const original = file.patch;
      const parsed = getRenderablePrFilePatch(file, file.patch, "test");
      expect(file.patchStatus).toBe("available");
      expect(parsed?.kind).toBe("files");
      if (parsed?.kind !== "files") throw new Error("Expected a renderable patch");
      expect(parsed.files[0]?.name).toBe(path);
      expect(parsed.files[0]?.prevName).toBe("old name.ts");
      expect(parsed.files[0]?.hunks[0]?.additionStart).toBe(5);
      expect(parsed.files[0]?.hunks[0]?.deletionStart).toBe(5);
      expect(file.patch).toBe(original);
      expect(isPrReviewAnchorInPatch({ path, side: "RIGHT", line: 5 }, file.patch!)).toBe(true);
    },
  );
  it.each(["added", "removed"])("preserves %s file rendering", (status) => {
    const added = status === "added";
    const file = fileFixture({
      filename: "new file.ts",
      sha: "blob",
      status,
      additions: added ? 1 : 0,
      deletions: added ? 0 : 1,
      patch: added ? "@@ -0,0 +1 @@\n+new" : "@@ -1 +0,0 @@\n-old",
    });
    const parsed = getRenderablePrFilePatch(file, file.patch, "test");
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") throw new Error("Expected a renderable patch");
    expect(parsed.files[0]?.type).toBe(added ? "new" : "deleted");
  });
});

// Representative server wire format, kept here to avoid importing server runtime
// code into the web TypeScript project.
function fileFixture(input: {
  filename: string;
  previous_filename?: string;
  sha: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
}): PrHubChangedFile {
  const oldPath = JSON.stringify(`a/${input.previous_filename ?? input.filename}`);
  const newPath = JSON.stringify(`b/${input.filename}`);
  return {
    path: input.filename,
    previousPath: input.previous_filename ?? null,
    blobOid: input.sha,
    additions: input.additions,
    deletions: input.deletions,
    changeType:
      input.status === "added" ? "added" : input.status === "removed" ? "deleted" : "renamed",
    patchStatus: "available",
    patch: `diff --git ${oldPath} ${newPath}\n--- ${input.status === "added" ? "/dev/null" : oldPath}\n+++ ${input.status === "removed" ? "/dev/null" : newPath}\n${input.patch}\n`,
  };
}
