import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "parse5";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openContainedFile } from "../assetHttp.ts";
import { HtmlRenderPrepareError, prepareHtmlRender } from "./prepareHtmlRender.ts";

vi.mock("parse5", async (importOriginal) => {
  const actual = await importOriginal<typeof import("parse5")>();
  return { ...actual, parse: vi.fn(actual.parse) };
});
vi.mock("../assetHttp.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../assetHttp.ts")>();
  return { ...actual, openContainedFile: vi.fn(actual.openContainedFile) };
});

const temporary: string[] = [];
beforeEach(() => vi.clearAllMocks());
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
  const { html: result } = await prepareHtmlRender(
    `<img src="${project}/café.png"><img src="https://example.test/image.png"><img src="//example.test/other.png"><script>const text='<img src="/private.png">'</script>`,
    [project],
  );
  expect(result).toContain('src="data:image/png;base64,AQID"');
  expect(result).toContain('src="https://example.test/image.png"');
  expect(result).toContain('src="//example.test/other.png"');
  expect(result).toContain("const text=");
});
it("refuses traversal, sibling roots and file URLs, and never reads a symlink escaping the project", async () => {
  const { root, project } = await fixture();
  await symlink(path.join(root, "private.png"), path.join(project, "escape.png"));
  for (const image of [
    path.join(root, "private.png"),
    `${project}/../private.png`,
    `file://${root}/private.png`,
  ])
    await expect(prepareHtmlRender(`<img src="${image}">`, [project])).rejects.toThrow(
      /private\.png is outside the folders a page can read\. Keep images inside the project, worktree or attachments\./,
    );
  const escaped = await prepareHtmlRender(`<img src="${project}/escape.png">`, [project]);
  expect(escaped.html).not.toContain("data:");
  expect(escaped.missing).toEqual({ paths: [`${project}/escape.png`], omitted: 0 });
});
it("enforces the HTML byte limit before parsing and bounds inlined image memory", async () => {
  const { project } = await fixture();
  await expect(prepareHtmlRender("é".repeat(262145), [project])).rejects.toThrow("512 KiB");
  expect(parse).not.toHaveBeenCalled();
  await writeFile(path.join(project, "large.png"), Buffer.alloc(10 * 1024 * 1024 + 1));
  await expect(prepareHtmlRender(`<img src="${project}/large.png">`, [project])).rejects.toThrow(
    `The local image ${project}/large.png is 10.0 MiB; images can be at most 10 MiB.`,
  );
  await expect(prepareHtmlRender(`<img src="${project}/notes.txt">`, [project])).rejects.toThrow(
    `The local image ${project}/notes.txt has an unsupported format.`,
  );
});

it("rejects viewport height units in stylesheets, SVG, templates and decoded style attributes", async () => {
  for (const [html, unit] of [
    ["<style>main{min-height:100vh}</style>", "100vh"],
    ["<svg><style>rect{height:50DVH}</style></svg>", "50DVH"],
    ["<template><style>.a{height:.5svh}</style></template>", ".5svh"],
    ['<template><div style="height:10lvh"></div></template>', "10lvh"],
    ['<div style="height:100&#118;h">x</div>', "100vh"],
    ["<style>main{height:100\\76h}</style>", "100vh"],
    ["<style>main{margin-top:-10vh}</style>", "10vh"],
    ["<style>main{height:calc(100% - 2*10vh)}</style>", "10vh"],
    ["<style>main{height:max(200px,50vh)}</style>", "50vh"],
    ['<svg height="100vh"><rect width="10" height="10"/></svg>', "100vh"],
  ] as const)
    await expect(prepareHtmlRender(html, [])).rejects.toThrow(
      `The page uses a viewport height unit (${unit}).`,
    );
});

it("allows viewport units outside CSS code", async () => {
  for (const html of [
    "<style>/* avoid 100vh */ main{height:200px}</style>",
    `<style>main::after{content:"100vh \\" 2vh"}</style>`,
    "<style>main{width:1vhx}</style>",
    "<p>Use 100vh with care</p>",
    "<script>document.body.style.height='100vh'</script>",
    '<img src="data:image/png;base64,AAA1vh+/1vh">',
    '<div style="background:url(data:image/png;base64,ab+1vh)"></div>',
    '<div style="background:url(data:image/png;base64,1vh+abc)"></div>',
    "<style>.min-h-100vh{min-height:200px}</style>",
    '<div style="background:url(chart-1vh.png)"></div>',
    '<div data-height="100vh" title="100vh">x</div>',
  ])
    await expect(prepareHtmlRender(html, [])).resolves.toMatchObject({
      missing: { paths: [], omitted: 0 },
    });
});

it("validates every style before reading any image", async () => {
  const { project } = await fixture();
  await expect(
    prepareHtmlRender(`<img src="${project}/café.png"><div style="height:100vh"></div>`, [project]),
  ).rejects.toThrow(HtmlRenderPrepareError);
  expect(openContainedFile).not.toHaveBeenCalled();
});

it("opens a repeated missing image once and bounds the missing list", async () => {
  const { project } = await fixture();
  const repeated = await prepareHtmlRender(`<img src="${project}/gone.png">`.repeat(1000), [
    project,
  ]);
  expect(openContainedFile).toHaveBeenCalledOnce();
  expect(repeated.missing).toEqual({ paths: [`${project}/gone.png`], omitted: 0 });
  const many = await prepareHtmlRender(
    Array.from({ length: 101 }, (_, index) => `<img src="${project}/gone-${index}.png">`).join(""),
    [project],
  );
  expect(many.missing.paths).toHaveLength(20);
  expect(many.missing.omitted).toBe(81);
  const long = await prepareHtmlRender(`<img src="${project}/${"a".repeat(2000)}.png">`, [project]);
  expect(long.missing.paths[0]).toHaveLength(1024);
  expect(long.missing.paths[0]?.endsWith("…")).toBe(true);
});

it("checks a 512 KiB adversarial page quickly", async () => {
  const half = 256 * 1024;
  for (const html of [
    `<style>${"1".repeat(half)}${"/*".repeat(half / 4)}</style>`,
    `<div style="${"1.".repeat(half / 2)}">x</div>`,
    `<style>${'"\\'.repeat(half / 3)}</style>`,
  ]) {
    const started = performance.now();
    await prepareHtmlRender(html, []).catch(() => undefined);
    expect(performance.now() - started).toBeLessThan(200);
  }
});
