// @effect-diagnostics nodeBuiltinImport:off
// Throwaway git repositories for tests that need real history.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface GitFixture {
  root: string;
  git: (args: readonly string[]) => string;
  write: (path: string, content: string) => void;
  remove: (path: string) => void;
  /** Commits everything at a fixed time (seconds) and returns the commit SHA. */
  commit: (message: string, time: number) => string;
  cleanup: () => void;
}

export function createGitFixture(prefix = "git-fixture-"): GitFixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const run = (args: readonly string[], env: Record<string, string> = {}) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    }).trim();
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  run(["config", "commit.gpgsign", "false"]);
  run(["config", "tag.gpgsign", "false"]);
  return {
    root,
    git: (args) => run(args),
    write: (path, content) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    },
    remove: (path) => rmSync(join(root, path)),
    commit: (message, time) => {
      const date = `@${time} +0000`;
      run(["add", "-A"]);
      run(["commit", "-q", "--allow-empty", "-m", message], {
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      });
      return run(["rev-parse", "HEAD"]);
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
