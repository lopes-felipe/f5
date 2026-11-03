import { describe, expect, it } from "vitest";
import {
  isExplicitRelativePath,
  resolvePastedPath,
  isNetworkPath,
  isUncPath,
  isWindowsAbsolutePath,
  isWindowsDrivePath,
  workspaceRelativeFilePath,
} from "./path";

describe("resolvePastedPath", () => {
  it.each([
    ["Finder, a space", "", "'/Users/me/Monarch Money'", "/Users/me/Monarch Money"],
    ["Finder, an apostrophe", "", "/Users/me/Bob\\'s\\ Stuff", "/Users/me/Bob's Stuff"],
    ["Finder, a backslash", "", "/Users/me/a\\\\\\ b", "/Users/me/a\\ b"],
    [
      "Finder, apostrophes around a name",
      "",
      "/Users/me/\\'My\\ Folder\\'",
      "/Users/me/'My Folder'",
    ],
    ["Explorer, a drive", "", '"C:\\Users\\me\\My Code"', "C:\\Users\\me\\My Code"],
    ["Explorer, a share", "", '"\\\\host\\share\\My Code"', "\\\\host\\share\\My Code"],
    ["an apostrophe in double quotes", "", '"/Users/me/Bob\'s Stuff"', "/Users/me/Bob's Stuff"],
    ["a shell, home-relative", "", "~/Bob\\'s\\ Stuff", "~/Bob's Stuff"],
    ["surrounding whitespace", "", "  '/Users/me/My Code'\n", "/Users/me/My Code"],
    ["over a selection", "/Users/me/old", "'/Users/me/My Code'", "/Users/me/My Code"],
    ["after a prefilled folder", "~/", "~/'/Users/me/My Code'", "/Users/me/My Code"],
    ["plain, after a prefilled folder", "~/", "~//Users/me/code", "/Users/me/code"],
    ["after a Windows folder", "C:\\Users\\", 'C:\\Users\\"D:\\My Code"', "D:\\My Code"],
    ["a shell's quoted apostrophe", "", "'/Users/me/Bob'\\''s Work'", "/Users/me/Bob's Work"],
    ["after a clone destination", "~/code/repo", "~/code/repo'/a b'", "/a b"],
    ["over part of the box", "~/code/old", "~/code/'/a b'", "/a b"],
  ])("reads the path copied from %s", (_source, previous, next, expected) => {
    expect(resolvePastedPath(previous, next)).toBe(expected);
  });

  it.each([
    ["typing a separator", "/Users/me", "/Users/me/"],
    ["typing a separator after a folder", "~/", "~//"],
    ["typing a trailing space", "/Users/My", "/Users/My "],
    ["deleting", "/Users/me/", "/Users/me"],
    ["pasting a relative folder", "~/", "~/Documents/code"],
    ["a longer path over a selection", "/Users/me", "/Users/me/code"],
    ["a longer path after a folder", "/Users/me/", "/Users/me/code"],
    ["quoted text that is no path", "", "'hello world'"],
    ["a quoted relative path", "", "'code/my app'"],
    ["a search ending in a quoted path", "", "find '/tmp/repo'"],
    ["a quote left open", "", "'/Users/me/My Code"],
    ["a quote inside the quotes", "", "'/Users/me/it's here'"],
    ["Windows separators", "", "C:\\Users\\me\\code"],
    ["a Windows dot folder", "", "C:\\Users\\me\\.config"],
    ["a Windows dot folder below home", "", "~/code\\.vscode"],
    ["a share", "", "\\\\host\\share\\code"],
    ["a backslash before a letter", "", "/Users/me/a\\b"],
  ])("keeps %s", (_case, previous, next) => {
    expect(resolvePastedPath(previous, next)).toBe(next);
  });

  it.each(["/Users/me/a\\ b", "~/code\\.vscode", "'/Users/me/My Code'"])(
    "leaves %s typed one character at a time",
    (typed) => {
      const box = [...typed].reduce((text, char) => resolvePastedPath(text, text + char), "");
      expect(box).toBe(typed);
    },
  );
});

describe("path helpers", () => {
  it.each([
    String.raw`\\host\share`,
    "//host/share",
    String.raw`/\host/share`,
    String.raw`\/host/share`,
    String.raw`\\?\C:\outside`,
  ])("recognizes network path %s", (value) => {
    expect(isNetworkPath(value)).toBe(true);
    expect(workspaceRelativeFilePath(value, "C:\\repo")).toBeNull();
  });
  it("confines share paths to the current workspace", () => {
    expect(workspaceRelativeFilePath("//host/share/repo/image.png", "\\\\HOST\\share\\repo")).toBe(
      "image.png",
    );
    expect(
      workspaceRelativeFilePath("//host/share/repo/../secret.png", "//host/share/repo"),
    ).toBeNull();
    expect(
      workspaceRelativeFilePath("//host/share/repository/image.png", "//host/share/repo"),
    ).toBeNull();
  });
  it("detects windows drive paths", () => {
    expect(isWindowsDrivePath("C:\\repo")).toBe(true);
    expect(isWindowsDrivePath("D:/repo")).toBe(true);
    expect(isWindowsDrivePath("/repo")).toBe(false);
  });

  it("detects UNC paths", () => {
    expect(isUncPath("\\\\server\\share\\repo")).toBe(true);
    expect(isUncPath("C:\\repo")).toBe(false);
  });

  it("detects windows absolute paths", () => {
    expect(isWindowsAbsolutePath("C:\\repo")).toBe(true);
    expect(isWindowsAbsolutePath("\\\\server\\share\\repo")).toBe(true);
    expect(isWindowsAbsolutePath("./repo")).toBe(false);
  });

  it("detects explicit relative paths", () => {
    expect(isExplicitRelativePath(".")).toBe(true);
    expect(isExplicitRelativePath("..")).toBe(true);
    expect(isExplicitRelativePath("./repo")).toBe(true);
    expect(isExplicitRelativePath("..\\repo")).toBe(true);
    expect(isExplicitRelativePath("~/repo")).toBe(false);
  });
});
