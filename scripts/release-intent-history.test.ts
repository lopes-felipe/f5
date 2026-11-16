import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  acceptanceOnlyCommit,
  publisherIdentity,
  stableRequests,
} from "./release/release-github.ts";

afterEach(() => vi.unstubAllEnvs());

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
  // Scope the real release helpers to this fixture without booting a Node process
  // for every observation. Vitest isolates this worker's environment.
  vi.stubEnv("GIT_DIR", join(directory, ".git"));
  vi.stubEnv("GIT_WORK_TREE", directory);
  vi.stubEnv("GIT_CONFIG_GLOBAL", env.GIT_CONFIG_GLOBAL);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_COUNT", "0");
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
  expect(stableRequests(merged)).toEqual([{ ...intent, sourceSha: merged }]);
  expect(merged).not.toBe(preparation);
  expect(Number(git(["rev-list", "--first-parent", "--count", base + ".." + merged]))).toBe(2);
  const identity = publisherIdentity();
  writeFileSync(join(directory, "state.txt"), "an unrelated application change\n");
  git(["add", "state.txt"]);
  git(["commit", "-m", "unrelated application change"]);
  expect(publisherIdentity()).toBe(identity);
  const reports = join(directory, "docs/computer-certification");
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(reports, "acceptance-0.1.2-codex-chrome-darwin-arm64.json"), "{}\n");
  git(["add", "docs"]);
  git(["commit", "-m", "accept the pinned candidate"]);
  const evidence = git(["rev-parse", "HEAD"]);
  expect(acceptanceOnlyCommit(evidence)).toBe(true);
  expect(acceptanceOnlyCommit(merged)).toBe(false);
  expect(publisherIdentity()).not.toBe(identity);
  const afterEvidence = publisherIdentity();
  mkdirSync(join(directory, "scripts"), { recursive: true });
  writeFileSync(
    join(directory, "scripts/reconcile-releases.ts"),
    "// publisher implementation change\n",
  );
  git(["add", "scripts"]);
  git(["commit", "-m", "change publisher"]);
  expect(publisherIdentity()).not.toBe(afterEvidence);
  const recovery = {
    ...intent,
    requestId: "00000000-0000-4000-8000-000000000002",
    supersedes: intent.requestId,
  };
  writeFileSync(join(directory, "release-intent.json"), JSON.stringify(recovery) + "\n");
  git(["add", "release-intent.json"]);
  git(["commit", "-m", "explicit recovery"]);
  const recovered = git(["rev-parse", "HEAD"]);
  git(["revert", "--no-edit", recovered]);
  const history = stableRequests(git(["rev-parse", "HEAD"]));
  expect(history).toEqual([
    { ...intent, sourceSha: merged },
    { ...recovery, sourceSha: recovered },
  ]);
}, 15_000);
