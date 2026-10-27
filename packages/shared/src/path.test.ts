import { describe, expect, it } from "vitest";
import {
  isExplicitRelativePath,
  isNetworkPath,
  isUncPath,
  isWindowsAbsolutePath,
  isWindowsDrivePath,
  workspaceRelativeFilePath,
} from "./path";

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
