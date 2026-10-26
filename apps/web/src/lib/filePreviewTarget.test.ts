import { describe, expect, it } from "vitest";
import { isExternalTextPreviewPath, resolveFilePreviewTarget } from "./filePreviewTarget";

it.each(["/tmp/report.json", "/tmp/notes.md", "/tmp/.env", "/tmp/app.ts"])(
  "accepts text-like external preview %s",
  (path) => expect(isExternalTextPreviewPath(path)).toBe(true),
);
it.each([
  "/tmp/screenshot.png",
  "/tmp/report.pdf",
  "/tmp/photo.heic",
  "/tmp/file.bin",
  "/tmp/unknown.xyz",
])("leaves media/binary external reference %s with the existing handoff", (path) =>
  expect(isExternalTextPreviewPath(path)).toBe(false),
);

describe("resolveFilePreviewTarget", () => {
  it.each(["/repo/project", "/repo/worktree"])("keeps relative files in %s", (cwd) => {
    expect(resolveFilePreviewTarget("docs/guide.json", cwd)).toEqual({
      cwd,
      relativePath: "docs/guide.json",
      readOnly: false,
    });
  });

  it.each([
    [
      "/tmp/natura-imagens-categorias/imagens.json",
      "/tmp/natura-imagens-categorias",
      "imagens.json",
    ],
    ["/private/tmp/another folder/report.txt", "/private/tmp/another folder", "report.txt"],
    ["/report.txt", "/", "report.txt"],
    ["C:\\Temp\\report.json", "C:/Temp", "report.json"],
    ["C:/report.json", "C:/", "report.json"],
  ])("previews %s read-only without losing its directory", (filePath, cwd, relativePath) => {
    expect(resolveFilePreviewTarget(filePath, "/repo/project")).toEqual({
      cwd,
      relativePath,
      readOnly: true,
    });
    expect(resolveFilePreviewTarget(filePath, undefined)?.cwd).toBe(cwd);
  });

  it.each([
    undefined,
    "/tmp/",
    "/tmp/.",
    "/tmp/..",
    "//host/share/file.json",
    "\\\\host\\share\\file.json",
  ])("does not turn %s into a local file request", (filePath) =>
    expect(resolveFilePreviewTarget(filePath, "/repo/project")).toBeUndefined(),
  );
  it("requires context for a relative path", () => {
    expect(resolveFilePreviewTarget("report.json", undefined)).toBeUndefined();
  });
});
