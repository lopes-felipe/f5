import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";

import {
  clearCommandResolutionCache,
  CommandNotFoundError,
  preferGitForWindowsBinary,
  resolveExecutable,
  resolveGitExecutable,
  resolveInvocation,
} from "./resolveCommand.ts";
import { runProviderCliCommand } from "../provider/providerCli.ts";

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
  it("honors case-insensitive Path/PATHEXT keys, quoted entries, and extension order", () => {
    const directory = tempDir("f5 resolve command ");
    writeExecutable(path.join(directory, "agent.CMD"));
    writeExecutable(path.join(directory, "agent.EXE"));

    expect(
      resolveExecutable(
        "agent",
        { Path: `"${directory}"`, PathExt: ".CMD;.EXE" },
        { platform: "win32", useCache: false },
      ),
    ).toBe(path.join(directory, "agent.CMD"));
  });

  it("rejects directories and does not treat drive-relative paths as PATH lookups", () => {
    const directory = tempDir("f5-resolve-command-");
    mkdirSync(path.join(directory, "tool.EXE"));
    expect(
      resolveExecutable("tool", { PATH: directory }, { platform: "win32", useCache: false }),
    ).toBeNull();
    expect(
      resolveExecutable("C:tool", { PATH: directory }, { platform: "win32", useCache: false }),
    ).toBeNull();
  });

  it("does not cache misses after a command is installed into the same PATH", () => {
    const directory = tempDir("f5-resolve-command-");
    const executable = path.join(directory, "late-agent.EXE");
    const env = { PATH: directory, PATHEXT: ".EXE" };
    expect(resolveExecutable("late-agent", env, { platform: "win32" })).toBeNull();
    writeExecutable(executable);
    expect(resolveExecutable("late-agent", env, { platform: "win32" })).toBe(executable);
  });

  it("resolves extension-less absolute POSIX executables", () => {
    const executable = path.join(tempDir("f5-resolve-command-"), "agent");
    writeExecutable(executable);
    expect(resolveExecutable(executable, {}, { platform: "linux", useCache: false })).toBe(
      executable,
    );
  });
});

describe("preferGitForWindowsBinary", () => {
  const files =
    (...paths: Array<string>) =>
    (filePath: string) =>
      paths.includes(filePath);

  it("runs the git.exe Git for Windows' launcher would start", () => {
    // 2.56+ on x64. The PATHEXT scan returns the extension in PATHEXT's case.
    expect(
      preferGitForWindowsBinary(
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
      preferGitForWindowsBinary(
        "D:\\PortableGit\\bin\\git.exe",
        {},
        files("D:\\PortableGit\\mingw64\\bin\\git.exe"),
      ),
    ).toBe("D:\\PortableGit\\mingw64\\bin\\git.exe");
    expect(
      preferGitForWindowsBinary(
        "C:\\Program Files\\Git\\cmd\\git.exe",
        {},
        files("C:\\Program Files\\Git\\clangarm64\\bin\\git.exe"),
      ),
    ).toBe("C:\\Program Files\\Git\\clangarm64\\bin\\git.exe");
  });

  it("keeps the launcher when MSYSTEM is set", () => {
    // The real git.exe only adds its own folders to PATH when MSYSTEM is unset;
    // without them a `#!/bin/sh` hook cannot start.
    expect(
      preferGitForWindowsBinary(
        "C:\\Program Files\\Git\\cmd\\git.exe",
        { MSYSTEM: "MINGW64" },
        files("C:\\Program Files\\Git\\mingw64\\bin\\git.exe"),
      ),
    ).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
  });

  it("keeps the launcher when no git.exe sits beside it", () => {
    expect(preferGitForWindowsBinary("C:\\Program Files\\Git\\cmd\\git.exe", {}, () => false)).toBe(
      "C:\\Program Files\\Git\\cmd\\git.exe",
    );
  });

  it("leaves other gits and other launchers alone", () => {
    const everything = () => true;
    expect(preferGitForWindowsBinary("C:\\Users\\me\\scoop\\shims\\git.exe", {}, everything)).toBe(
      "C:\\Users\\me\\scoop\\shims\\git.exe",
    );
    expect(preferGitForWindowsBinary("C:\\Program Files\\Git\\cmd\\gitk.exe", {}, everything)).toBe(
      "C:\\Program Files\\Git\\cmd\\gitk.exe",
    );
  });
});

describe("resolveGitExecutable", () => {
  it("leaves the lookup to the platform off Windows", () => {
    expect(resolveGitExecutable({ PATH: "/usr/bin" }, "darwin")).toBe("git");
  });

  it("spawns a git.exe found on PATH directly, but leaves a git.cmd wrapper to Node", () => {
    const exeDirectory = tempDir("f5-resolve-git-");
    writeExecutable(path.join(exeDirectory, "git.EXE"));
    expect(
      resolveGitExecutable({ PATH: exeDirectory, PATHEXT: ".EXE", MSYSTEM: "MINGW64" }, "win32"),
    ).toBe(path.join(exeDirectory, "git.EXE"));

    const cmdDirectory = tempDir("f5-resolve-git-");
    writeExecutable(path.join(cmdDirectory, "git.CMD"));
    expect(resolveGitExecutable({ PATH: cmdDirectory, PATHEXT: ".CMD;.EXE" }, "win32")).toBe("git");
  });
});

describe("resolveInvocation", () => {
  it("passes POSIX invocations through unchanged", () => {
    expect(resolveInvocation("agent", ["--version"], {}, { platform: "linux" })).toEqual({
      file: "agent",
      args: ["--version"],
      kind: "native",
    });
  });

  it("runs native Windows executables directly", () => {
    const directory = tempDir("f5-resolve-command-");
    const executable = path.join(directory, "agent.EXE");
    writeExecutable(executable);
    expect(
      resolveInvocation(
        "agent",
        ["--version"],
        { PATH: directory, PATHEXT: ".EXE" },
        { platform: "win32", useCache: false },
      ),
    ).toEqual({ file: executable, args: ["--version"], kind: "native" });
  });

  it("runs JavaScript entries and standard npm cmd shims through node.exe", () => {
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

    const directAbsolute = resolveInvocation(script, ["a b"], env, {
      platform: "win32",
      useCache: false,
    });
    expect(directAbsolute).toMatchObject({
      args: [script, "a b"],
      kind: "nodeScript",
    });
    expect(directAbsolute.file.toLowerCase()).toBe(node.toLowerCase());

    const directFromPath = resolveInvocation("direct.js", ["a b"], env, {
      platform: "win32",
      useCache: false,
    });
    expect(directFromPath).toMatchObject({
      args: [directScript, "a b"],
      kind: "nodeScript",
    });
    expect(directFromPath.file.toLowerCase()).toBe(node.toLowerCase());

    const npmShim = resolveInvocation(
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

  it("resolves relative shims against the child cwd and prefers their adjacent node.exe", () => {
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
      resolveInvocation(
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

  it.each([".bat", ".ps1"])("rejects unsupported %s scripts", (extension) => {
    const directory = tempDir("f5-resolve-command-");
    writeExecutable(path.join(directory, `agent${extension}`));
    expect(() =>
      resolveInvocation(
        "agent",
        [],
        { PATH: directory, PATHEXT: extension },
        { platform: "win32", useCache: false },
      ),
    ).toThrow(CommandNotFoundError);
  });

  it("rejects malformed command shims and missing commands with typed errors", () => {
    const directory = tempDir("f5-resolve-command-");
    writeFileSync(path.join(directory, "agent.cmd"), "@echo off\r\necho nope %*\r\n");
    const env = { PATH: directory, PATHEXT: ".CMD" };
    expect(() =>
      resolveInvocation("agent", [], env, { platform: "win32", useCache: false }),
    ).toThrow(CommandNotFoundError);
    expect(() =>
      resolveInvocation("missing", [], env, { platform: "win32", useCache: false }),
    ).toThrow(CommandNotFoundError);
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
      const invocation = resolveInvocation(shim, args, environment);
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
