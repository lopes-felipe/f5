import { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureWindowsPathHydration,
  hydrateWindowsPath,
  mergeWindowsPathValues,
  readWindowsRegistryPaths,
  resetWindowsPathCache,
} from "./windowsPath";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

afterEach(() => {
  vi.mocked(execFile).mockReset();
  vi.unstubAllEnvs();
  resetWindowsPathCache();
});

function mockPowerShell() {
  const child = { kill: vi.fn(), unref: vi.fn() };
  const complete = new Promise<(error: Error | null, stdout: string) => void>((resolve) => {
    vi.mocked(execFile).mockImplementationOnce((_file, _args, _options, callback) => {
      resolve((error, stdout) => callback?.(error, stdout, ""));
      return child as unknown as ReturnType<typeof execFile>;
    });
  });
  return { ...child, complete };
}

describe("Windows registry probe", () => {
  it("probes asynchronously with hidden windows and falls back after a launch failure", async () => {
    const primary = mockPowerShell();
    const fallback = mockPowerShell();
    const result = readWindowsRegistryPaths({ SystemRoot: "D:\\Windows" });
    const completePrimary = await primary.complete;
    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", expect.any(String)],
      { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 },
      expect.any(Function),
    );
    completePrimary(new Error("spawn failed"), "");
    const completeFallback = await fallback.complete;
    expect(vi.mocked(execFile).mock.calls[1]?.[0]).toBe("pwsh.exe");
    completeFallback(null, JSON.stringify(["C:\\Machine Tools", "D:\\User Tools"]));
    await expect(result).resolves.toEqual({ machine: "C:\\Machine Tools", user: "D:\\User Tools" });
  });

  it("kills the probe on startup interruption and allows a later retry", async () => {
    const primary = mockPowerShell();
    const controller = new AbortController();
    const startup = ensureWindowsPathHydration(process.env, {
      platform: "win32",
      signal: controller.signal,
    });
    const cancelled = expect(startup).rejects.toMatchObject({ name: "AbortError" });
    await primary.complete;
    controller.abort();
    await cancelled;
    expect(primary.kill).toHaveBeenCalledOnce();
    expect(primary.unref).toHaveBeenCalledOnce();
    expect(execFile).toHaveBeenCalledOnce();

    vi.stubEnv("PATH", process.env.PATH);
    const retry = mockPowerShell();
    const restarted = ensureWindowsPathHydration(process.env, { platform: "win32" });
    (await retry.complete)(null, JSON.stringify(["C:\\Tools", null]));
    await expect(restarted).resolves.toMatchObject({ registryRead: true });
    expect(process.env.PATH?.split(";")).toContain("C:\\Tools");
  });

  it("stops waiting at the existing deadline even if the child never calls back", async () => {
    vi.useFakeTimers();
    try {
      const primary = mockPowerShell();
      const result = readWindowsRegistryPaths({});
      await primary.complete;
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(result).resolves.toBeUndefined();
      expect(primary.kill).toHaveBeenCalledOnce();
      expect(primary.unref).toHaveBeenCalledOnce();
      expect(execFile).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the shared probe running for another caller after startup interruption", async () => {
    vi.stubEnv("PATH", process.env.PATH);
    const primary = mockPowerShell();
    const controller = new AbortController();
    const startup = ensureWindowsPathHydration(process.env, {
      platform: "win32",
      signal: controller.signal,
    });
    const cancelled = expect(startup).rejects.toMatchObject({ name: "AbortError" });
    const restricted = { Path: "C:\\Restricted" };
    const other = ensureWindowsPathHydration(restricted, { platform: "win32" });
    const complete = await primary.complete;
    controller.abort();
    await cancelled;
    expect(primary.kill).not.toHaveBeenCalled();
    complete(null, JSON.stringify(["C:\\Tools", null]));
    await expect(other).resolves.toEqual({ path: "C:\\Restricted", registryRead: true });
    expect(restricted).toEqual({ Path: "C:\\Restricted" });
    expect(execFile).toHaveBeenCalledOnce();
  });
});

describe("Windows PATH hydration", () => {
  it("merges case-insensitively while preserving first-seen order", () => {
    expect(
      mergeWindowsPathValues(['"C:\\Tools";C:\\Windows\\System32\\', "c:\\tools;D:\\Node"]),
    ).toBe("C:\\Tools;C:\\Windows\\System32;D:\\Node");
  });

  it("removes embedded quotes from Windows PATH entries", () => {
    expect(
      mergeWindowsPathValues(['C:\\"Program Files"\\Node;"C:\\Tools"', "C:\\Program Files\\Node"]),
    ).toBe("C:\\Program Files\\Node;C:\\Tools");
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
