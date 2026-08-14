import { describe, expect, it, vi } from "vitest";

import { hydrateWindowsPath, mergeWindowsPathValues } from "./windowsPath";

describe("Windows PATH hydration", () => {
  it("merges case-insensitively while preserving first-seen order", () => {
    expect(
      mergeWindowsPathValues(['"C:\\Tools";C:\\Windows\\System32\\', "c:\\tools;D:\\Node"]),
    ).toBe("C:\\Tools;C:\\Windows\\System32;D:\\Node");
  });

  it("replaces duplicate PATH key spellings and appends existing known directories", async () => {
    const env: NodeJS.ProcessEnv = {
      Path: "C:\\Inherited",
      PATH: "C:\\Duplicate",
      APPDATA: "C:\\Users\\Test\\AppData\\Roaming",
    };
    await hydrateWindowsPath(env, {
      platform: "win32",
      readRegistryPaths: async () => ({
        machine: "C:\\Windows\\System32",
        user: "c:\\inherited;D:\\UserTools",
      }),
      pathExists: async (candidate) => candidate.endsWith("\\npm"),
    });
    expect(Object.keys(env).filter((key) => key.toLowerCase() === "path")).toEqual(["PATH"]);
    expect(env.PATH).toBe(
      "C:\\Inherited;C:\\Windows\\System32;D:\\UserTools;C:\\Users\\Test\\AppData\\Roaming\\npm",
    );
  });

  it("falls back to inherited PATH and warns when registry lookup fails", async () => {
    const warn = vi.fn();
    const env = { Path: "C:\\Inherited" };
    expect(
      await hydrateWindowsPath(env, {
        platform: "win32",
        readRegistryPaths: async () => undefined,
        pathExists: async () => false,
        warn,
      }),
    ).toBe("C:\\Inherited");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("finds native provider shims under the user-local bin directory", async () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "C:\\Windows\\System32",
      USERPROFILE: "C:\\Users\\Test",
    };

    await hydrateWindowsPath(env, {
      platform: "win32",
      readRegistryPaths: async () => undefined,
      pathExists: async (candidate) => candidate === "C:\\Users\\Test\\.local\\bin",
    });

    expect(env.PATH).toBe("C:\\Windows\\System32;C:\\Users\\Test\\.local\\bin");
  });
});
