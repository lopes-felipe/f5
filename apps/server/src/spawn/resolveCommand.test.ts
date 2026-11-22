import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";

import {
  clearCommandResolutionCache,
  isCommandAvailable,
  CommandNotFoundError,
  npmShimExecutable,
  preferGitForWindowsBinary,
  resolveExecutable,
  resolveExecutables,
  resolveGitExecutable,
  resolveInvocation,
} from "./resolveCommand.ts";
import { runProviderCliCommand } from "../provider/providerCli.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat), readdir: vi.fn(actual.readdir) };
});

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function writeExecutable(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "fixture");
  chmodSync(filePath, 0o755);
}

afterEach(clearCommandResolutionCache);

describe("resolveExecutable", () => {
  it("shares PATH listings across availability checks and invocations until the directory changes", async () => {
    const directory = tempDir("f5-listings-");
    try {
      writeExecutable(path.join(directory, "cursor.CMD"));
      utimesSync(directory, 946684800, 946684800);
      const env = { PATH: directory, PATHEXT: ".EXE;.CMD" };
      const options = { platform: "win32" as const };
      vi.mocked(readdir).mockClear();
      vi.mocked(stat).mockClear();
      const [executables, available] = await Promise.all([
        resolveExecutables("cursor", env, options),
        isCommandAvailable("absent", { ...options, env }),
      ]);
      expect(executables).toEqual([path.join(directory, "cursor.CMD")]);
      expect(available).toBe(false);
      await expect(resolveInvocation("missing", [], env, options)).rejects.toThrow(
        CommandNotFoundError,
      );
      expect(readdir).toHaveBeenCalledTimes(1);
      expect(
        vi
          .mocked(stat)
          .mock.calls.map(([file]) => file)
          .filter((file) => file !== directory),
      ).toEqual([path.join(directory, "cursor.CMD")]);
      writeExecutable(path.join(directory, "late.EXE"));
      utimesSync(directory, 946684830, 946684830);
      expect(await resolveExecutables("late", env, options)).toEqual([
        path.join(directory, "late.EXE"),
      ]);
      expect(readdir).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("honors case-insensitive Path/PATHEXT keys, quoted entries, and extension order", async () => {
    const directory = tempDir("f5 resolve command ");
    writeExecutable(path.join(directory, "agent.CMD"));
    writeExecutable(path.join(directory, "agent.EXE"));

    expect(
      await resolveExecutable(
        "agent",
        { Path: `"${directory}"`, PathExt: ".CMD;.EXE" },
        { platform: "win32", useCache: false },
      ),
    ).toBe(path.join(directory, "agent.CMD"));
  });

  it("rejects directories and does not treat drive-relative paths as PATH lookups", async () => {
    const directory = tempDir("f5-resolve-command-");
    mkdirSync(path.join(directory, "tool.EXE"));
    expect(
      await resolveExecutable("tool", { PATH: directory }, { platform: "win32", useCache: false }),
    ).toBeNull();
    expect(
      await resolveExecutable(
        "C:tool",
        { PATH: directory },
        { platform: "win32", useCache: false },
      ),
    ).toBeNull();
  });

  it("does not cache misses after a command is installed into the same PATH", async () => {
    const directory = tempDir("f5-resolve-command-");
    const executable = path.join(directory, "late-agent.EXE");
    const env = { PATH: directory, PATHEXT: ".EXE" };
    expect(await resolveExecutable("late-agent", env, { platform: "win32" })).toBeNull();
    writeExecutable(executable);
    expect(await resolveExecutable("late-agent", env, { platform: "win32" })).toBe(executable);
  });

  it("rereads recently modified directories even if their mtime is unchanged", async () => {
    const directory = tempDir("f5-path-recent-");
    try {
      const recent = Date.now() / 1000;
      utimesSync(directory, recent, recent);
      const executable = path.join(directory, "late.EXE");
      const options = { platform: "win32" as const, env: { PATH: directory, PATHEXT: ".EXE" } };
      vi.mocked(readdir).mockClear();
      expect(await isCommandAvailable("late", options)).toBe(false);
      writeExecutable(executable);
      utimesSync(directory, recent, recent);
      expect(await isCommandAvailable("late", options)).toBe(true);
      expect(readdir).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("probes Windows short names even when the directory listing omits them", async () => {
    const directory = tempDir("f5-path-short-name-");
    const alias = path.join(directory, "MYTOOL~1.CMD");
    const executable = path.join(directory, "MyToolLongName.cmd");
    const actualStat = (
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    ).stat;
    vi.mocked(stat).mockImplementation((file) => actualStat(file === alias ? executable : file));
    try {
      writeExecutable(executable);
      expect(
        await resolveExecutable(
          "MYTOOL~1",
          { PATH: directory, PATHEXT: ".CMD" },
          { platform: "win32" },
        ),
      ).toBe(alias);
    } finally {
      vi.mocked(stat).mockImplementation(actualStat);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  describe("PATH entry deduplication", () => {
    // Records the files a miss stats, so the walk runs over every PATH entry.
    // Assertions compare against a lookup over the distinct entries rather
    // than a fixed count, so they don't depend on how candidates are spelled.
    async function probedPaths(pathValue: string): Promise<string[]> {
      vi.mocked(stat).mockClear();
      expect(
        await resolveExecutable(
          "definitely-not-installed",
          { PATH: pathValue, PATHEXT: ".COM;.EXE" },
          { platform: "win32", useCache: false },
        ),
      ).toBeNull();
      return vi.mocked(stat).mock.calls.map(([filePath]) => String(filePath));
    }

    it("visits a repeated PATH directory only once", async () => {
      const first = tempDir("f5-resolve-command-");
      const second = tempDir("f5-resolve-command-");
      const distinct = await probedPaths([first, second].join(";"));
      const probed = await probedPaths([first, second, first, `"${second}"`].join(";"));

      expect(distinct.length).toBeGreaterThan(0);
      expect(probed).toEqual(distinct);
      expect(new Set(probed).size).toBe(probed.length);
    });

    it("still visits PATH entries that differ only in case", async () => {
      // Windows can mark a directory case-sensitive, so the two spellings are
      // not provably one directory.
      const lower = await probedPaths("C:\\bin");
      const upper = await probedPaths("C:\\BIN");

      expect(lower.length).toBeGreaterThan(0);
      expect(await probedPaths("C:\\bin;C:\\BIN")).toEqual([...lower, ...upper]);
    });
  });

  it("resolves extension-less absolute POSIX executables", async () => {
    const executable = path.join(tempDir("f5-resolve-command-"), "agent");
    writeExecutable(executable);
    expect(await resolveExecutable(executable, {}, { platform: "linux", useCache: false })).toBe(
      executable,
    );
  });
});

describe("resolveExecutables", () => {
  // POSIX PATH splitting on ":" cannot express a Windows temp directory (C:\...).
  it.skipIf(process.platform === "win32")(
    "returns every PATH match in order, once per directory",
    async () => {
      const first = tempDir("f5-resolve-all-");
      const second = tempDir("f5-resolve-all-");
      const empty = tempDir("f5-resolve-all-");
      writeExecutable(path.join(first, "tool"));
      writeExecutable(path.join(second, "tool"));
      const env = { PATH: [first, empty, second, first].join(":") };
      try {
        expect(await resolveExecutables("tool", env, { platform: "linux" })).toEqual([
          path.join(first, "tool"),
          path.join(second, "tool"),
        ]);
        expect(await resolveExecutables("missing", env, { platform: "linux" })).toEqual([]);
      } finally {
        for (const directory of [first, second, empty]) rmSync(directory, { recursive: true });
      }
    },
  );

  it("takes the first PATHEXT match in each Windows PATH directory", async () => {
    const first = tempDir("f5-resolve-all-");
    const second = tempDir("f5-resolve-all-");
    writeExecutable(path.join(first, "tool.CMD"));
    writeExecutable(path.join(first, "tool.EXE"));
    writeExecutable(path.join(second, "tool.CMD"));
    const env = { Path: `${first};${second}`, PATHEXT: ".EXE;.CMD" };
    try {
      expect(await resolveExecutables("tool", env, { platform: "win32" })).toEqual([
        path.join(first, "tool.EXE"),
        path.join(second, "tool.CMD"),
      ]);
    } finally {
      for (const directory of [first, second]) rmSync(directory, { recursive: true });
    }
  });

  it("returns a qualified command only when it is executable", async () => {
    const executable = path.join(tempDir("f5-resolve-all-"), "agent");
    writeExecutable(executable);
    try {
      expect(await resolveExecutables(executable, {}, { platform: "linux" })).toEqual([executable]);
      expect(await resolveExecutables(`${executable}-missing`, {}, { platform: "linux" })).toEqual(
        [],
      );
    } finally {
      rmSync(path.dirname(executable), { recursive: true });
    }
  });
});

describe("preferGitForWindowsBinary", () => {
  const files =
    (...paths: Array<string>) =>
    (filePath: string) =>
      paths.includes(filePath);

  it("runs the git.exe Git for Windows' launcher would start", async () => {
    // 2.56+ on x64. The PATHEXT scan returns the extension in PATHEXT's case.
    expect(
      await preferGitForWindowsBinary(
        "C:\\Program Files\\Git\\cmd\\git.EXE",
        {},
        files(
          "C:\\Program Files\\Git\\ucrt64\\bin\\git.exe",
          "C:\\Program Files\\Git\\mingw64\\bin\\git.exe",
        ),
      ),
    ).toBe("C:\\Program Files\\Git\\ucrt64\\bin\\git.exe");
    // Before 2.56, and the portable build's bin launcher.
    expect(
      await preferGitForWindowsBinary(
        "D:\\PortableGit\\bin\\git.exe",
        {},
        files("D:\\PortableGit\\mingw64\\bin\\git.exe"),
      ),
    ).toBe("D:\\PortableGit\\mingw64\\bin\\git.exe");
    expect(
      await preferGitForWindowsBinary(
        "C:\\Program Files\\Git\\cmd\\git.exe",
        {},
        files("C:\\Program Files\\Git\\clangarm64\\bin\\git.exe"),
      ),
    ).toBe("C:\\Program Files\\Git\\clangarm64\\bin\\git.exe");
  });

  it("keeps the launcher when MSYSTEM is set", async () => {
    // The real git.exe only adds its own folders to PATH when MSYSTEM is unset;
    // without them a `#!/bin/sh` hook cannot start.
    expect(
      await preferGitForWindowsBinary(
        "C:\\Program Files\\Git\\cmd\\git.exe",
        { MSYSTEM: "MINGW64" },
        files("C:\\Program Files\\Git\\mingw64\\bin\\git.exe"),
      ),
    ).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
  });

  it("keeps the launcher when no git.exe sits beside it", async () => {
    expect(
      await preferGitForWindowsBinary("C:\\Program Files\\Git\\cmd\\git.exe", {}, () => false),
    ).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
  });

  it("leaves other gits and other launchers alone", async () => {
    const everything = () => true;
    expect(
      await preferGitForWindowsBinary("C:\\Users\\me\\scoop\\shims\\git.exe", {}, everything),
    ).toBe("C:\\Users\\me\\scoop\\shims\\git.exe");
    expect(
      await preferGitForWindowsBinary("C:\\Program Files\\Git\\cmd\\gitk.exe", {}, everything),
    ).toBe("C:\\Program Files\\Git\\cmd\\gitk.exe");
  });
});

describe("resolveGitExecutable", () => {
  it("leaves the lookup to the platform on Linux", async () => {
    expect(await resolveGitExecutable({ PATH: "/usr/bin" }, "linux")).toBe("git");
  });

  // The fixtures are real temp files on a `:`-separated PATH, which a Windows
  // host's drive-letter paths cannot form.
  describe.skipIf(process.platform === "win32")("on macOS", () => {
    // A PATH directory whose git stands in for the xcrun shim, and an Xcode git.
    const setup = () => {
      const shimDirectory = tempDir("f5-macos-git-shim-");
      const shim = path.join(shimDirectory, "git");
      writeExecutable(shim);
      const xcodeGit = path.join(tempDir("f5-xcode-"), "usr", "bin", "git");
      writeExecutable(xcodeGit);
      const host = { located: xcodeGit as string | undefined, calls: 0 };
      const locateXcodeGit = () => {
        host.calls += 1;
        return host.located;
      };
      const resolve = async (env: NodeJS.ProcessEnv = { PATH: shimDirectory }) =>
        await resolveGitExecutable(env, "darwin", { macosGitShim: shim, locateXcodeGit });
      return { host, resolve, shimDirectory, xcodeGit };
    };

    it("runs the git behind the xcrun shim and looks it up once", async () => {
      const { host, resolve, xcodeGit } = setup();
      const results = await Promise.all(Array.from({ length: 12 }, () => resolve()));
      expect(results).toEqual(Array(12).fill(xcodeGit));
      expect(await resolve()).toBe(xcodeGit);
      expect(host.calls).toBe(1);
    });

    it("keeps each locator's answer apart in the cache", async () => {
      const { resolve, shimDirectory, xcodeGit } = setup();
      expect(await resolve()).toBe(xcodeGit);
      expect(
        await resolveGitExecutable({ PATH: shimDirectory }, "darwin", {
          macosGitShim: path.join(shimDirectory, "git"),
          locateXcodeGit: () => undefined,
        }),
      ).toBe("git");
    });

    it("keeps git when PATH has another git first", async () => {
      const { host, resolve, shimDirectory } = setup();
      const homebrew = tempDir("f5-homebrew-");
      writeExecutable(path.join(homebrew, "git"));
      expect(await resolve({ PATH: `${homebrew}:${shimDirectory}` })).toBe("git");
      expect(host.calls).toBe(0);
    });

    it("keeps git when xcrun fails or names a missing file", async () => {
      const failed = setup();
      failed.host.located = undefined;
      expect(await failed.resolve()).toBe("git");

      const missing = setup();
      missing.host.located = path.join(tempDir("f5-xcode-"), "git");
      expect(await missing.resolve()).toBe("git");
    });

    it("looks again when the resolved git disappears", async () => {
      const { host, resolve, xcodeGit } = setup();
      expect(await resolve()).toBe(xcodeGit);

      rmSync(xcodeGit);
      const betaGit = path.join(tempDir("f5-xcode-beta-"), "git");
      writeExecutable(betaGit);
      host.located = betaGit;
      expect(await resolve()).toBe(betaGit);
      expect(host.calls).toBe(2);
    });
  });

  it("spawns a git.exe found on PATH directly, but leaves a git.cmd wrapper to Node", async () => {
    const exeDirectory = tempDir("f5-resolve-git-");
    writeExecutable(path.join(exeDirectory, "git.EXE"));
    expect(
      await resolveGitExecutable(
        { PATH: exeDirectory, PATHEXT: ".EXE", MSYSTEM: "MINGW64" },
        "win32",
      ),
    ).toBe(path.join(exeDirectory, "git.EXE"));

    const cmdDirectory = tempDir("f5-resolve-git-");
    writeExecutable(path.join(cmdDirectory, "git.CMD"));
    expect(await resolveGitExecutable({ PATH: cmdDirectory, PATHEXT: ".CMD;.EXE" }, "win32")).toBe(
      "git",
    );
  });
});

// Byte for byte what `npm install -g opencode-ai` writes as `opencode.cmd`.
const NPM_OPENCODE_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*',
  "",
].join("\r\n");

describe("npmShimExecutable", () => {
  const shimPath = "C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd";
  const executable =
    "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe";
  const exists = (filePath: string) => filePath === executable;
  const everything = () => true;

  it("finds the executable npm's shim runs", async () => {
    expect(await npmShimExecutable(shimPath, () => NPM_OPENCODE_SHIM, exists)).toBe(executable);
    expect(
      await npmShimExecutable(shimPath.replace(".cmd", ".CMD"), () => NPM_OPENCODE_SHIM, exists),
    ).toBe(executable);
  });

  it("keeps a shim that does more than run the executable", async () => {
    const withSetting = NPM_OPENCODE_SHIM.replace(
      "SETLOCAL",
      "SETLOCAL\r\nSET OPENCODE_CONFIG=C:\\x",
    );
    expect(await npmShimExecutable(shimPath, () => withSetting, exists)).toBeUndefined();
    const nodeScript = NPM_OPENCODE_SHIM.replace(
      '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*',
      '"%_prog%"  "%dp0%\\node_modules\\opencode-ai\\bin\\opencode.js" %*',
    );
    expect(await npmShimExecutable(shimPath, () => nodeScript, everything)).toBeUndefined();
  });

  it("keeps a shim CMD would read differently", async () => {
    // CMD keeps trailing characters in an unquoted `SET` value, so these point
    // `dp0`, and with it the executable, somewhere else.
    for (const suffix of ["\u00a0", "\t", " "]) {
      const altered = NPM_OPENCODE_SHIM.replace("SET dp0=%~dp0", `SET dp0=%~dp0${suffix}`);
      expect(await npmShimExecutable(shimPath, () => altered, everything)).toBeUndefined();
    }
    const nonBreakingSeparator = NPM_OPENCODE_SHIM.replace(
      'opencode.exe"   %*',
      'opencode.exe"\u00a0%*',
    );
    expect(
      await npmShimExecutable(shimPath, () => nonBreakingSeparator, everything),
    ).toBeUndefined();
    const indented = NPM_OPENCODE_SHIM.replace("SETLOCAL", "  SETLOCAL");
    expect(await npmShimExecutable(shimPath, () => indented, everything)).toBeUndefined();
  });

  it("keeps the shim when its executable is missing or it is not a .cmd", async () => {
    expect(
      await npmShimExecutable(
        shimPath,
        () => NPM_OPENCODE_SHIM,
        () => false,
      ),
    ).toBeUndefined();
    expect(await npmShimExecutable(shimPath, () => undefined, everything)).toBeUndefined();
    expect(
      await npmShimExecutable(
        shimPath.replace(".cmd", ".bat"),
        () => NPM_OPENCODE_SHIM,
        everything,
      ),
    ).toBeUndefined();
  });
});

describe("resolveInvocation", () => {
  it("waits for asynchronous filesystem discovery before resolving a Windows launch", async () => {
    const directory = tempDir("f5-async-command-");
    const executable = path.join(directory, "agent.EXE");
    try {
      writeExecutable(executable);
      const info = await stat(executable);
      const { promise, resolve } = Promise.withResolvers<typeof info>();
      vi.mocked(stat)
        .mockClear()
        .mockImplementationOnce(() => promise);
      const pending = resolveInvocation(executable, [], {}, { platform: "win32" });
      try {
        expect(stat).toHaveBeenCalledExactlyOnceWith(executable);
      } finally {
        resolve(info);
      }
      await expect(pending).resolves.toEqual({ file: executable, args: [], kind: "native" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("passes POSIX invocations through unchanged", async () => {
    expect(await resolveInvocation("agent", ["--version"], {}, { platform: "linux" })).toEqual({
      file: "agent",
      args: ["--version"],
      kind: "native",
    });
  });

  it("runs native Windows executables directly", async () => {
    const directory = tempDir("f5-resolve-command-");
    const executable = path.join(directory, "agent.EXE");
    writeExecutable(executable);
    expect(
      await resolveInvocation(
        "agent",
        ["--version"],
        { PATH: directory, PATHEXT: ".EXE" },
        { platform: "win32", useCache: false },
      ),
    ).toEqual({ file: executable, args: ["--version"], kind: "native" });
  });

  it("runs JavaScript entries and standard npm cmd shims through node.exe", async () => {
    const directory = tempDir("f5 resolve command (shim) & ");
    const node = path.join(directory, "node.exe");
    const script = path.join(directory, "node_modules", "agent", "cli.js");
    const directScript = path.join(directory, "direct.js");
    const shim = path.join(directory, "agent.cmd");
    writeExecutable(node);
    writeExecutable(script);
    writeExecutable(directScript);
    writeFileSync(
      shim,
      [
        "@ECHO off",
        'IF EXIST "%~dp0\\node.exe" (',
        '  "%~dp0\\node.exe" "%~dp0\\node_modules\\agent\\cli.js" %*',
        ") ELSE (",
        '  node "%~dp0\\node_modules\\agent\\cli.js" %*',
        ")",
      ].join("\r\n"),
    );
    const env = { PATH: directory, PATHEXT: ".CMD;.EXE" };

    const directAbsolute = await resolveInvocation(script, ["a b"], env, {
      platform: "win32",
      useCache: false,
    });
    expect(directAbsolute).toMatchObject({
      args: [script, "a b"],
      kind: "nodeScript",
    });
    expect(directAbsolute.file.toLowerCase()).toBe(node.toLowerCase());

    const directFromPath = await resolveInvocation("direct.js", ["a b"], env, {
      platform: "win32",
      useCache: false,
    });
    expect(directFromPath).toMatchObject({
      args: [directScript, "a b"],
      kind: "nodeScript",
    });
    expect(directFromPath.file.toLowerCase()).toBe(node.toLowerCase());

    const npmShim = await resolveInvocation(
      "agent",
      ['otel.exporter="none"', "mcp_servers={x={}}"],
      env,
      { platform: "win32", useCache: false },
    );
    expect(npmShim).toMatchObject({
      args: [script, 'otel.exporter="none"', "mcp_servers={x={}}"],
      kind: "npmShim",
    });
    expect(npmShim.file.toLowerCase()).toBe(node.toLowerCase());
  });

  it("resolves relative shims against the child cwd and prefers their adjacent node.exe", async () => {
    const directory = tempDir("f5 relative shim & ");
    const node = path.join(directory, "node.exe");
    const script = path.join(directory, "cli.js");
    const shim = path.join(directory, "agent.cmd");
    writeExecutable(node);
    writeExecutable(script);
    writeFileSync(
      shim,
      [
        "@ECHO off",
        'IF EXIST "%~dp0\\node.exe" (',
        '  "%~dp0\\node.exe" "%~dp0\\cli.js" %*',
        ") ELSE (",
        '  node "%~dp0\\cli.js" %*',
        ")",
      ].join("\r\n"),
    );

    expect(
      await resolveInvocation(
        ".\\agent",
        ["value & literal"],
        { PATH: "", PATHEXT: ".CMD" },
        {
          platform: "win32",
          cwd: directory,
          useCache: false,
        },
      ),
    ).toEqual({
      file: node,
      args: [script, "value & literal"],
      kind: "npmShim",
    });
  });

  it("runs the executable behind an npm shim directly", async () => {
    const directory = tempDir("f5 npm exe shim & ");
    const executable = path.join(directory, "node_modules", "opencode-ai", "bin", "opencode.exe");
    writeExecutable(executable);
    writeFileSync(path.join(directory, "opencode.CMD"), NPM_OPENCODE_SHIM);

    expect(
      await resolveInvocation(
        "opencode",
        ["serve", "--port=4096"],
        { PATH: directory, PATHEXT: ".CMD" },
        { platform: "win32", useCache: false },
      ),
    ).toEqual({ file: executable, args: ["serve", "--port=4096"], kind: "native" });
  });

  it.each([".bat", ".ps1"])("rejects unsupported %s scripts", async (extension) => {
    const directory = tempDir("f5-resolve-command-");
    writeExecutable(path.join(directory, `agent${extension}`));
    await expect(
      resolveInvocation(
        "agent",
        [],
        { PATH: directory, PATHEXT: extension },
        { platform: "win32", useCache: false },
      ),
    ).rejects.toThrow(CommandNotFoundError);
  });

  it("rejects malformed command shims and missing commands with typed errors", async () => {
    const directory = tempDir("f5-resolve-command-");
    writeFileSync(path.join(directory, "agent.cmd"), "@echo off\r\necho nope %*\r\n");
    const env = { PATH: directory, PATHEXT: ".CMD" };
    await expect(
      resolveInvocation("agent", [], env, { platform: "win32", useCache: false }),
    ).rejects.toThrow(CommandNotFoundError);
    await expect(
      resolveInvocation("missing", [], env, { platform: "win32", useCache: false }),
    ).rejects.toThrow(CommandNotFoundError);
  });

  it.skipIf(process.platform !== "win32")(
    "preserves exact argv through raw Node and Effect spawn paths for a real npm cmd shim",
    async () => {
      const directory = tempDir("f5 argv fixture (spaces) & ");
      const script = path.join(directory, "argv-echo.js");
      const shim = path.join(directory, "argv-echo.cmd");
      writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n");
      writeFileSync(
        shim,
        [
          "@ECHO off",
          'IF EXIST "%~dp0\\node.exe" (',
          '  "%~dp0\\node.exe" "%~dp0\\argv-echo.js" %*',
          ") ELSE (",
          '  node "%~dp0\\argv-echo.js" %*',
          ")",
        ].join("\r\n"),
      );
      const args = [
        'quoted "value"',
        "100%",
        "bang!",
        "caret^",
        "",
        "trailing\\\\",
        'otel.exporter="none"',
        'mcp_servers={demo={command="node",args=["a b"]}}',
      ];
      const environment = { ...process.env, PATH: `${directory};${process.env.PATH ?? ""}` };
      const invocation = await resolveInvocation(shim, args, environment);
      const raw = spawnSync(invocation.file, [...invocation.args], {
        env: environment,
        encoding: "utf8",
      });
      expect(raw.status).toBe(0);
      expect(JSON.parse(raw.stdout)).toEqual(args);

      const effectResult = await Effect.runPromise(
        runProviderCliCommand(shim, args, {
          baseEnvironment: environment,
          binaryPath: shim,
          envOverrides: { PATH: environment.PATH },
        }).pipe(Effect.provide(NodeServices.layer)),
      );
      expect(effectResult.code).toBe(0);
      expect(JSON.parse(effectResult.stdout)).toEqual(args);
    },
  );
});
