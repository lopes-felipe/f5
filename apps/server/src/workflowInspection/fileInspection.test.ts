import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  canonicalRoots,
  InspectionError,
  listInspectionDirectory,
  paginateLines,
  readInspectionFile,
  resolveInspectionPath,
} from "./fileInspection.ts";

let base: string;
let workspace: string;
let outside: string;

beforeEach(async () => {
  base = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "f5-file-inspection-"));
  workspace = NodePath.join(base, "workspace");
  outside = NodePath.join(base, "outside");
  await NodeFs.mkdir(NodePath.join(workspace, "src"), { recursive: true });
  await NodeFs.mkdir(outside);
  await NodeFs.writeFile(NodePath.join(workspace, "src", "a.ts"), "one\ntwo\nthree\n");
  await NodeFs.writeFile(NodePath.join(outside, "secret.txt"), "secret");
});

afterEach(async () => {
  await NodeFs.rm(base, { recursive: true, force: true });
});

async function expectCode(promise: Promise<unknown>, code: InspectionError["code"]) {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof InspectionError && error.code === code,
  );
}

describe("file inspection", () => {
  it("reads numbered, paginated lines inside the workspace", async () => {
    const roots = await canonicalRoots([workspace]);
    const page = await readInspectionFile(roots, { path: "src/a.ts", startLine: 2, maxLines: 1 });
    expect(page.path).toBe("src/a.ts");
    expect(page.content).toContain("two");
    expect(page.content).not.toContain("three");
    expect(page.truncated).toBe(true);
    expect(page.nextStartLine).toBe(3);
  });

  it("rejects traversal and absolute paths outside the workspace", async () => {
    const roots = await canonicalRoots([workspace]);
    await expectCode(resolveInspectionPath(roots, "../outside/secret.txt"), "outside_roots");
    await expectCode(
      resolveInspectionPath(roots, NodePath.join(outside, "secret.txt")),
      "outside_roots",
    );
  });

  it("rejects symbolic links that escape the workspace", async () => {
    await NodeFs.symlink(outside, NodePath.join(workspace, "escape"));
    const roots = await canonicalRoots([workspace]);
    await expectCode(readInspectionFile(roots, { path: "escape/secret.txt" }), "outside_roots");
    await expectCode(listInspectionDirectory(roots, { path: "escape" }), "outside_roots");
  });

  it("reports binary files without returning their bytes", async () => {
    await NodeFs.writeFile(NodePath.join(workspace, "blob.bin"), Buffer.from([0, 1, 2, 0, 3]));
    const roots = await canonicalRoots([workspace]);
    const result = await readInspectionFile(roots, { path: "blob.bin" });
    expect(result.binary).toBe(true);
    expect(result.content).toBe("");
  });

  it("paginates with explicit limits and a next offset", () => {
    const page = paginateLines("a\nb\nc\nd", { startLine: 1, maxLines: 2 });
    expect(page.startLine).toBe(1);
    expect(page.endLine).toBe(2);
    expect(page.nextStartLine).toBe(3);
  });
});
