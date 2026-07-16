import { describe, expect, it, vi } from "vitest";

import { hydrateWindowsPath, mergeWindowsPathValues } from "./windowsPath";

describe("Windows PATH hydration", () => {
  it("merges case-insensitively while preserving first-seen order", () => {
    expect(
      mergeWindowsPathValues(['"C:\\Tools";C:\\Windows\\System32\\', "c:\\tools;D:\\Node"]),
    ).toBe("C:\\Tools;C:\\Windows\\System32;D:\\Node");
  });

  it("replaces duplicate PATH key spellings and appends existing known directories", () => {
    const env: NodeJS.ProcessEnv = {
      Path: "C:\\Inherited",
      PATH: "C:\\Duplicate",
      APPDATA: "C:\\Users\\Test\\AppData\\Roaming",
    };
    hydrateWindowsPath(env, {
      platform: "win32",
      readRegistryPaths: () => ({
        machine: "C:\\Windows\\System32",
        user: "c:\\inherited;D:\\UserTools",
      }),
      pathExists: (candidate) => candidate.endsWith("\\npm"),
    });
    expect(Object.keys(env).filter((key) => key.toLowerCase() === "path")).toEqual(["PATH"]);
    expect(env.PATH).toBe(
      "C:\\Inherited;C:\\Windows\\System32;D:\\UserTools;C:\\Users\\Test\\AppData\\Roaming\\npm",
    );
  });

  it("falls back to inherited PATH and warns when registry lookup fails", () => {
    const warn = vi.fn();
    const env = { Path: "C:\\Inherited" };
    expect(
      hydrateWindowsPath(env, {
        platform: "win32",
        readRegistryPaths: () => undefined,
        pathExists: () => false,
        warn,
      }),
    ).toBe("C:\\Inherited");
    expect(warn).toHaveBeenCalledOnce();
  });
});
