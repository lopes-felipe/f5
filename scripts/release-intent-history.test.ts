import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("pins stable intent to the main merge commit rather than the preparation branch commit", () => {
  const directory = mkdtempSync(join(tmpdir(), "f5-release-history-"));
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_COUNT: "0",
  };
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: directory,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(["init", "--initial-branch=main"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.com"]);
  writeFileSync(join(directory, "state.txt"), "base\n");
  git(["add", "state.txt"]);
  git(["commit", "-m", "base"]);
  const base = git(["rev-parse", "HEAD"]);
  git(["switch", "-c", "prepare"]);
  const intent = { version: "0.1.2", requestId: "00000000-0000-4000-8000-000000000001" };
  writeFileSync(join(directory, "release-intent.json"), JSON.stringify(intent) + "\n");
  git(["add", "release-intent.json"]);
  git(["commit", "-m", "prepare"]);
  const preparation = git(["rev-parse", "HEAD"]);
  git(["switch", "main"]);
  writeFileSync(join(directory, "state.txt"), "concurrent main change\n");
  git(["add", "state.txt"]);
  git(["commit", "-m", "main"]);
  git(["merge", "--no-ff", "prepare", "-m", "Merge stable preparation"]);
  const merged = git(["rev-parse", "HEAD"]);
  const module = fileURLToPath(new URL("./release/release-github.ts", import.meta.url));
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import {stableRequests} from " +
        JSON.stringify(pathToFileURL(module).href) +
        "; console.log(JSON.stringify(stableRequests(" +
        JSON.stringify(merged) +
        ")));",
    ],
    { cwd: directory, env, encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  expect(JSON.parse(output)).toEqual([{ ...intent, sourceSha: merged }]);
  expect(merged).not.toBe(preparation);
  expect(Number(git(["rev-list", "--first-parent", "--count", base + ".." + merged]))).toBe(2);
});
