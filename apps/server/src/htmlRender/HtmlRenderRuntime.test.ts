import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { htmlRenderImageRoots } from "./HtmlRenderRuntime.ts";
import { prepareHtmlRender } from "./prepareHtmlRender.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("lets a scratch thread inline only its own folder, not a sibling scratch thread's", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "f5-html-scratch-"));
  temporary.push(root);
  const own = path.join(root, "own");
  const sibling = path.join(root, "sibling");
  const attachments = path.join(root, "attachments");
  for (const folder of [own, sibling, attachments]) await mkdir(folder);
  await writeFile(path.join(own, "mine.png"), Buffer.from([1, 2, 3]));
  await writeFile(path.join(sibling, "theirs.png"), Buffer.from([4, 5, 6]));
  const roots = htmlRenderImageRoots(
    { worktreePath: null, scratchPath: own },
    { kind: "scratch", workspaceRoot: root },
    attachments,
  );
  expect(roots).toEqual([own, attachments]);
  await expect(prepareHtmlRender(`<img src="${own}/mine.png">`, roots)).resolves.toContain(
    "data:image/png;base64,AQID",
  );
  await expect(prepareHtmlRender(`<img src="${sibling}/theirs.png">`, roots)).rejects.toThrow();
  // A scratch thread whose folder is not allocated yet reads only attachments.
  expect(
    htmlRenderImageRoots(
      { worktreePath: null, scratchPath: null },
      { kind: "scratch", workspaceRoot: root },
      attachments,
    ),
  ).toEqual([attachments]);
});

it("keeps the project root and worktree for standard projects", () => {
  expect(
    htmlRenderImageRoots(
      { worktreePath: "/repo/.worktrees/a" },
      { kind: "standard", workspaceRoot: "/repo" },
      "/attachments",
    ),
  ).toEqual(["/repo", "/repo/.worktrees/a", "/attachments"]);
});
