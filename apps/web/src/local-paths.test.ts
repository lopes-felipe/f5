import { describe, expect, it } from "vitest";

import {
  appendLocalFileUrlPosition,
  isWindowsAbsolutePath,
  parseLocalFileUrl,
} from "./local-paths";

describe("local path parsing", () => {
  it("recognizes slash and backslash Windows paths and UNC paths", () => {
    expect(isWindowsAbsolutePath("C:\\Users\\Test\\a.ts")).toBe(true);
    expect(isWindowsAbsolutePath("C:/Users/Test/a.ts")).toBe(true);
    expect(isWindowsAbsolutePath("\\\\server\\share\\a.ts")).toBe(true);
  });

  it("accepts only local file URL hosts", () => {
    expect(parseLocalFileUrl("file:///C:/Users/Test/a.ts#L3")).toEqual({
      path: "C:/Users/Test/a.ts",
      hash: "#L3",
    });
    expect(parseLocalFileUrl("file://localhost/C:/Users/Test/a.ts")).toEqual({
      path: "C:/Users/Test/a.ts",
      hash: "",
    });
    expect(parseLocalFileUrl("file://remote-host/share/a.ts")).toBeNull();
  });

  it("preserves file URL line and column fragments", () => {
    expect(appendLocalFileUrlPosition("C:/repo/a.ts", "#L12C4")).toBe("C:/repo/a.ts:12:4");
  });
});
