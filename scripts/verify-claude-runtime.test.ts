import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type Context = {
  appOutDir: string;
  electronPlatformName: string;
  packager: { appInfo: { productFilename: string }; executableName?: string };
};
type Run = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; killSignal: string },
) => { status: number | null };
const require = createRequire(import.meta.url);
const { verifyClaudeRuntime } = require("./verify-claude-runtime.cjs") as {
  verifyClaudeRuntime(context: Context, dependencies: { run: Run }): void;
};

afterEach(() => vi.unstubAllEnvs());

describe("verifyClaudeRuntime", () => {
  it.each([
    [
      "darwin",
      join("F5 Test.app", "Contents", "MacOS", "F5 Test"),
      join("F5 Test.app", "Contents", "Resources"),
    ],
    ["win32", "F5 Test.exe", "resources"],
    ["linux", "f5", "resources"],
  ])("uses the packaged %s runtime and ASAR entry", (platform, executable, resources) => {
    vi.stubEnv("CSC_KEY_PASSWORD", "must-not-reach-the-smoke-process");
    const run = vi.fn<Run>(() => ({ status: 0 }));
    const root = join("/out", "with spaces");
    verifyClaudeRuntime(
      {
        appOutDir: root,
        electronPlatformName: platform!,
        packager: { appInfo: { productFilename: "F5 Test" }, executableName: "f5" },
      },
      { run },
    );
    expect(run).toHaveBeenCalledExactlyOnceWith(
      join(root, executable!),
      [join(root, resources!, "app.asar", "apps", "server", "dist", "claude-runtime-smoke.mjs")],
      {
        env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: "1" }),
        timeout: 45_000,
        killSignal: "SIGKILL",
      },
    );
    expect(run.mock.calls[0]![2].env).not.toHaveProperty("CSC_KEY_PASSWORD");
    expect(Object.keys(run.mock.calls[0]![2].env)).toEqual(
      expect.arrayContaining(["ELECTRON_RUN_AS_NODE"]),
    );
  });

  it.each([1, null])("fails packaging when startup fails or times out (%s)", (status) => {
    expect(() =>
      verifyClaudeRuntime(
        {
          appOutDir: "/out",
          electronPlatformName: "win32",
          packager: { appInfo: { productFilename: "F5" } },
        },
        { run: () => ({ status }) },
      ),
    ).toThrow("Bundled Claude runtime smoke failed");
  });
});
