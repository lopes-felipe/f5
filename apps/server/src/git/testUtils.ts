import { accessSync, chmodSync, constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const GIT_WRAPPER_STATE_KEY = "__t3LocalPushFriendlyGitWrapperState__";
const REAL_GIT_ENV_KEY = "T3_REAL_GIT_BIN";

interface GitWrapperState {
  refCount: number;
  previousPath: string | undefined;
  previousRealGitBinary: string | undefined;
  wrapperDir: string;
}

function findGitBinaryOnPath(): string | null {
  const pathEntries = (process.env.PATH ?? "")
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/u, "$1"))
    .filter((entry) => entry.length > 0);
  const accessMode = process.platform === "win32" ? constants.F_OK : constants.X_OK;
  const commandNames =
    process.platform === "win32"
      ? Array.from(
          new Set([
            "git",
            ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
              .split(";")
              .map((extension) => extension.trim())
              .filter((extension) => extension.length > 0)
              .map((extension) =>
                extension.startsWith(".")
                  ? `git${extension.toLowerCase()}`
                  : `git.${extension.toLowerCase()}`,
              ),
          ]),
        )
      : ["git"];

  for (const pathEntry of pathEntries) {
    for (const commandName of commandNames) {
      const candidate = join(pathEntry, commandName);
      try {
        accessSync(candidate, accessMode);
        return candidate;
      } catch {
        continue;
      }
    }
  }

  return null;
}

function resolveRealGitBinary(): string {
  const configuredBinary = process.env[REAL_GIT_ENV_KEY]?.trim();
  if (configuredBinary) {
    return configuredBinary;
  }

  const gitBinary = findGitBinaryOnPath();
  if (gitBinary) {
    return gitBinary;
  }

  throw new Error("Could not resolve a git binary on PATH before installing the test wrapper.");
}

function createGitWrapperDir(realGitBinary: string): string {
  const wrapperDir = mkdtempSync(join(tmpdir(), "t3code-git-wrapper-"));
  const wrapperScriptPath = join(wrapperDir, "git-wrapper.cjs");
  const posixWrapperPath = join(wrapperDir, "git");
  const windowsWrapperPath = join(wrapperDir, "git.cmd");

  writeFileSync(
    wrapperScriptPath,
    [
      'const { spawnSync } = require("node:child_process");',
      'const { isAbsolute } = require("node:path");',
      'const { fileURLToPath } = require("node:url");',
      "",
      `const realGit = process.env.${REAL_GIT_ENV_KEY} || ${JSON.stringify(realGitBinary)};`,
      "const cwd = process.cwd();",
      "const args = process.argv.slice(2);",
      "",
      "function writeOutput(result) {",
      "  if (result.stdout) process.stdout.write(result.stdout);",
      "  if (result.stderr) process.stderr.write(result.stderr);",
      "}",
      "",
      "function runGit(commandArgs, targetCwd = cwd) {",
      "  const result = spawnSync(realGit, commandArgs, {",
      "    cwd: targetCwd,",
      '    encoding: "utf8",',
      "  });",
      "  if (result.error) throw result.error;",
      "  return result;",
      "}",
      "",
      "function passthrough() {",
      "  const result = runGit(args);",
      "  writeOutput(result);",
      "  process.exit(result.status ?? 1);",
      "}",
      "",
      "function mustGit(commandArgs, targetCwd = cwd) {",
      "  const result = runGit(commandArgs, targetCwd);",
      "  if ((result.status ?? 1) !== 0) {",
      "    writeOutput(result);",
      "    process.exit(result.status ?? 1);",
      "  }",
      '  return (result.stdout ?? "").trim();',
      "}",
      "",
      "function resolveLocalRemotePath(remoteUrl) {",
      '  const trimmed = (remoteUrl ?? "").trim();',
      "  if (!trimmed) return null;",
      '  if (trimmed.startsWith("file://")) {',
      "    try {",
      "      return fileURLToPath(trimmed);",
      "    } catch {",
      "      return null;",
      "    }",
      "  }",
      "  return isAbsolute(trimmed) ? trimmed : null;",
      "}",
      "",
      "function parsePushSpec(refspec, currentBranch) {",
      "  if (!refspec) return null;",
      '  if (refspec === "HEAD") {',
      "    return currentBranch",
      '      ? { source: "HEAD", destination: `refs/heads/${currentBranch}`, localBranch: currentBranch }',
      "      : null;",
      "  }",
      '  if (refspec.includes(":")) {',
      '    const [sourceRaw, destinationRaw] = refspec.split(":", 2);',
      '    const source = sourceRaw && sourceRaw.length > 0 ? sourceRaw : "HEAD";',
      "    const destination =",
      '      destinationRaw && destinationRaw.startsWith("refs/")',
      "        ? destinationRaw",
      '        : `refs/heads/${destinationRaw ?? ""}`;',
      "    return {",
      "      source,",
      "      destination,",
      '      localBranch: source === "HEAD" ? currentBranch : source,',
      "    };",
      "  }",
      "  return {",
      "    source: refspec,",
      "    destination: `refs/heads/${refspec}`,",
      "    localBranch: refspec,",
      "  };",
      "}",
      "",
      'if (args[0] !== "push") {',
      "  passthrough();",
      "}",
      "",
      'const currentBranch = mustGit(["branch", "--show-current"]);',
      "let setUpstream = false;",
      "let index = 1;",
      'while (index < args.length && args[index].startsWith("-")) {',
      "  const option = args[index];",
      '  if (option === "-u" || option === "--set-upstream") {',
      "    setUpstream = true;",
      "    index += 1;",
      "    continue;",
      "  }",
      "  passthrough();",
      "}",
      "",
      "let remoteName = args[index] ?? null;",
      "let refspecs = remoteName ? args.slice(index + 1) : [];",
      "",
      "if (!remoteName) {",
      '  const upstreamRef = mustGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);',
      '  const separatorIndex = upstreamRef.indexOf("/");',
      "  if (separatorIndex <= 0 || separatorIndex === upstreamRef.length - 1) {",
      "    passthrough();",
      "  }",
      "  remoteName = upstreamRef.slice(0, separatorIndex);",
      "  const upstreamBranch = upstreamRef.slice(separatorIndex + 1);",
      "  refspecs = [`HEAD:${upstreamBranch}`];",
      "}",
      "",
      "if (!remoteName) {",
      "  passthrough();",
      "}",
      "",
      'const remoteUrl = mustGit(["remote", "get-url", remoteName]);',
      "const remotePath = resolveLocalRemotePath(remoteUrl);",
      "if (!remotePath) {",
      "  passthrough();",
      "}",
      "",
      'const parsedSpecs = (refspecs.length > 0 ? refspecs : ["HEAD"])',
      "  .map((refspec) => parsePushSpec(refspec, currentBranch))",
      "  .filter(Boolean);",
      "if (parsedSpecs.length === 0) {",
      "  passthrough();",
      "}",
      "",
      "for (const spec of parsedSpecs) {",
      '  const sourceSha = mustGit(["rev-parse", spec.source]);',
      '  mustGit(["-C", remotePath, "fetch", cwd, `${sourceSha}:${spec.destination}`]);',
      '  if (!spec.destination.startsWith("refs/heads/")) {',
      "    continue;",
      "  }",
      '  const remoteBranch = spec.destination.slice("refs/heads/".length);',
      '  mustGit(["update-ref", `refs/remotes/${remoteName}/${remoteBranch}`, sourceSha]);',
      "  if (setUpstream && spec.localBranch) {",
      '    mustGit(["branch", "--set-upstream-to", `${remoteName}/${remoteBranch}`, spec.localBranch]);',
      "  }",
      "}",
      "",
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  writeFileSync(
    posixWrapperPath,
    [
      "#!/bin/sh",
      'script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
      'if [ -n "${NODE:-}" ]; then',
      '  exec "$NODE" "$script_dir/git-wrapper.cjs" "$@"',
      "fi",
      'exec node "$script_dir/git-wrapper.cjs" "$@"',
      "",
    ].join("\n"),
  );
  writeFileSync(
    windowsWrapperPath,
    [
      "@echo off",
      "setlocal",
      "if defined NODE (",
      '  "%NODE%" "%~dp0git-wrapper.cjs" %*',
      ") else (",
      '  node "%~dp0git-wrapper.cjs" %*',
      ")",
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n"),
  );
  chmodSync(posixWrapperPath, 0o755);

  return wrapperDir;
}

export function installLocalPushFriendlyGitWrapper(): () => void {
  const globalState = globalThis as typeof globalThis & {
    [GIT_WRAPPER_STATE_KEY]?: GitWrapperState;
  };

  const existingState = globalState[GIT_WRAPPER_STATE_KEY];
  if (existingState) {
    existingState.refCount += 1;
    return () => {
      existingState.refCount -= 1;
    };
  }

  const realGitBinary = resolveRealGitBinary();
  const wrapperDir = createGitWrapperDir(realGitBinary);
  const previousPath = process.env.PATH;
  const previousRealGitBinary = process.env[REAL_GIT_ENV_KEY];

  process.env.PATH = `${wrapperDir}${delimiter}${previousPath ?? ""}`;
  process.env[REAL_GIT_ENV_KEY] = realGitBinary;

  const state: GitWrapperState = {
    refCount: 1,
    previousPath,
    previousRealGitBinary,
    wrapperDir,
  };
  globalState[GIT_WRAPPER_STATE_KEY] = state;

  return () => {
    const currentState = globalState[GIT_WRAPPER_STATE_KEY];
    if (!currentState) {
      return;
    }

    currentState.refCount -= 1;
    if (currentState.refCount > 0) {
      return;
    }

    process.env.PATH = currentState.previousPath;
    if (currentState.previousRealGitBinary === undefined) {
      delete process.env[REAL_GIT_ENV_KEY];
    } else {
      process.env[REAL_GIT_ENV_KEY] = currentState.previousRealGitBinary;
    }
    rmSync(currentState.wrapperDir, { recursive: true, force: true });
    delete globalState[GIT_WRAPPER_STATE_KEY];
  };
}
