import * as Path from "node:path";
import { describe, expect, it } from "vitest";

import {
  defaultF5BaseDir,
  defaultF5DevStateDir,
  defaultF5UserdataStateDir,
  legacyT3BaseDir,
  legacyT3DevStateDir,
  legacyT3UserdataStateDir,
  isProtectedAppStateDir,
} from "./appStatePaths";

describe("app state paths", () => {
  const homeDir = Path.join(Path.sep, "Users", "test-user");

  it("uses F5-owned defaults for new state", () => {
    expect(defaultF5BaseDir(homeDir)).toBe(Path.join(homeDir, ".f5"));
    expect(defaultF5UserdataStateDir(homeDir)).toBe(Path.join(homeDir, ".f5", "userdata"));
    expect(defaultF5DevStateDir(homeDir)).toBe(Path.join(homeDir, ".f5", "dev"));
  });

  it("keeps legacy T3 paths addressable for one-time migration", () => {
    expect(legacyT3BaseDir(homeDir)).toBe(Path.join(homeDir, ".t3"));
    expect(legacyT3UserdataStateDir(homeDir)).toBe(Path.join(homeDir, ".t3", "userdata"));
    expect(legacyT3DevStateDir(homeDir)).toBe(Path.join(homeDir, ".t3", "dev"));
  });

  it("guards both F5 and legacy T3 state roots for destructive demo scripts", () => {
    expect(isProtectedAppStateDir(Path.join(homeDir, ".f5"), homeDir)).toBe(true);
    expect(isProtectedAppStateDir(Path.join(homeDir, ".f5", "userdata"), homeDir)).toBe(true);
    expect(isProtectedAppStateDir(Path.join(homeDir, ".t3"), homeDir)).toBe(true);
    expect(isProtectedAppStateDir(Path.join(homeDir, ".t3", "userdata"), homeDir)).toBe(true);
    expect(isProtectedAppStateDir("~/.t3/userdata", homeDir)).toBe(true);
    expect(isProtectedAppStateDir(Path.join(homeDir, "tmp", "f5-demo"), homeDir)).toBe(false);
  });
});
