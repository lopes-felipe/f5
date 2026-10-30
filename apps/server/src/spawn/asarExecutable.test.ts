import { describe, expect, it } from "vitest";

import { resolveAsarExecutablePath } from "./asarExecutable.ts";

describe("resolveAsarExecutablePath", () => {
  it.each([
    [
      "/Applications/F5 Test.app/Contents/Resources/app.asar/node_modules/claude",
      "/Applications/F5 Test.app/Contents/Resources/app.asar.unpacked/node_modules/claude",
    ],
    [
      String.raw`C:\Program Files\F5\resources\app.asar\node_modules\claude.exe`,
      String.raw`C:\Program Files\F5\resources\app.asar.unpacked\node_modules\claude.exe`,
    ],
    ["app.asar/claude", "app.asar.unpacked/claude"],
    ["/resources/app.asar.unpacked/claude", "/resources/app.asar.unpacked/claude"],
    ["/repo/node_modules/claude", "/repo/node_modules/claude"],
    ["/repo/app.asar-backup/claude", "/repo/app.asar-backup/claude"],
    ["/repo/app.asar", "/repo/app.asar"],
  ])("resolves %s to %s", (input, expected) => {
    expect(resolveAsarExecutablePath(input, { electron: true, fileExists: () => true })).toBe(
      expected,
    );
  });

  it("preserves ASAR-named directories outside Electron even if a sibling exists", () => {
    const executable = "/opt/tools/foo.asar/claude";
    expect(resolveAsarExecutablePath(executable, { electron: false, fileExists: () => true })).toBe(
      executable,
    );
  });

  it("preserves the original path when no unpacked sibling exists", () => {
    const executable = "/opt/tools/foo.asar/claude";
    expect(resolveAsarExecutablePath(executable, { electron: true, fileExists: () => false })).toBe(
      executable,
    );
  });
});
