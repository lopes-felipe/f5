import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareHtmlRender } from "./prepareHtmlRender.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "f5-html-images-"));
  temporary.push(root);
  const project = path.join(root, "project");
  await mkdir(project);
  await writeFile(path.join(project, "café.png"), Buffer.from([1, 2, 3]));
  await writeFile(path.join(root, "private.png"), "private-image");
  return { root, project };
}
it("inlines contained local images without changing remote URLs or treating script text as images", async () => {
  const { project } = await fixture();
  const result = await prepareHtmlRender(
    `<img src="${project}/café.png"><img src="https://example.test/image.png"><img src="//example.test/other.png"><script>const text='<img src="/private.png">'</script>`,
    [project],
  );
  expect(result).toContain('src="data:image/png;base64,AQID"');
  expect(result).toContain('src="https://example.test/image.png"');
  expect(result).toContain('src="//example.test/other.png"');
  expect(result).toContain("const text=");
});
it("refuses traversal, sibling roots, file URLs and symlinks escaping the authorized project", async () => {
  const { root, project } = await fixture();
  await symlink(path.join(root, "private.png"), path.join(project, "escape.png"));
  for (const image of [
    path.join(root, "private.png"),
    `${project}/../private.png`,
    `file://${root}/private.png`,
    `${project}/escape.png`,
  ])
    await expect(prepareHtmlRender(`<img src="${image}">`, [project])).rejects.toThrow();
});
it("enforces the HTML byte limit before parsing and bounds inlined image memory", async () => {
  const { project } = await fixture();
  await expect(prepareHtmlRender("é".repeat(262145), [project])).rejects.toThrow("512 KiB");
  await writeFile(path.join(project, "large.png"), Buffer.alloc(10 * 1024 * 1024 + 1));
  await expect(prepareHtmlRender(`<img src="${project}/large.png">`, [project])).rejects.toThrow(
    "10 MiB",
  );
});
