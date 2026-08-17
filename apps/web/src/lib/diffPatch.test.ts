import { describe, expect, it } from "vitest";

import {
  buildFileDiffLogicalIdentity,
  getRenderablePatch,
  resolveFileDiffPath,
  summarizeFileDiffMetadataStats,
} from "./diffPatch";

describe("summarizeFileDiffMetadataStats", () => {
  it("counts added and deleted lines across parsed files", () => {
    const patch = getRenderablePatch(`diff --git a/a.ts b/a.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,3 @@
-const before = true;
+const after = true;
 keep();
+added();
diff --git a/b.ts b/b.ts
index 3333333..4444444 100644
--- a/b.ts
+++ b/b.ts
@@ -1 +0,0 @@
-removed();`);

    expect(patch?.kind).toBe("files");
    if (!patch || patch.kind !== "files") return;
    expect(summarizeFileDiffMetadataStats(patch.files)).toEqual({ additions: 2, deletions: 2 });
  });
});

describe("file diff identity", () => {
  it("keeps repository paths beginning with a or b distinct", () => {
    const patch = getRenderablePatch(`diff --git a/a/x.ts b/a/x.ts
--- a/a/x.ts
+++ b/a/x.ts
@@ -1 +1 @@
-old
+new
diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1 +1 @@
-old
+new`);
    expect(patch?.kind).toBe("files");
    if (!patch || patch.kind !== "files") return;
    expect(patch.files.map(resolveFileDiffPath)).toEqual(["a/x.ts", "x.ts"]);
    expect(new Set(patch.files.map(buildFileDiffLogicalIdentity)).size).toBe(2);
  });
});
