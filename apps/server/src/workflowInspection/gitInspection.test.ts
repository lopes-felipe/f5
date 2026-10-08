import { execFileSync } from "node:child_process";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isSafeRevision, readOnlyGitArgv, readOnlyGitEnvironment } from "../git/readOnlyGit.ts";
import { canonicalRoots, InspectionError } from "./fileInspection.ts";
import { makeGitInspection, paginateText, requireRelativeGitPath } from "./gitInspection.ts";

let base: string;
let repo: string;
let marker: string;

function git(...args: string[]) {
  return execFileSync("git", args, {
    cwd: repo,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    encoding: "utf8",
  });
}

beforeEach(async () => {
  base = await NodeFs.realpath(
    await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "f5-git-inspection-")),
  );
  repo = NodePath.join(base, "repo");
  marker = NodePath.join(base, "helper-ran");
  await NodeFs.mkdir(repo);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  await NodeFs.writeFile(NodePath.join(repo, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "initial");
  // Helpers a hostile repository could configure. None may run during inspection.
  const helper = NodePath.join(base, "helper.sh");
  await NodeFs.writeFile(helper, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  git("config", "diff.external", helper);
  git("config", "diff.evil.textconv", helper);
  git("config", "core.fsmonitor", helper);
  await NodeFs.writeFile(NodePath.join(repo, ".gitattributes"), "*.txt diff=evil\n");
  await NodeFs.writeFile(NodePath.join(repo, "a.txt"), "one\ntwo\n");
});

afterEach(async () => {
  await NodeFs.rm(base, { recursive: true, force: true });
});

async function markerExists() {
  return NodeFs.access(marker).then(
    () => true,
    () => false,
  );
}

describe("git inspection", () => {
  it("never runs external diff, textconv, or fsmonitor helpers", async () => {
    const inspection = makeGitInspection(await canonicalRoots([repo]));
    const status = await inspection.status({});
    expect(status.text).toContain("a.txt");
    const diff = await inspection.diff({});
    expect(diff.text).toContain("+two");
    const commit = git("rev-parse", "HEAD").trim();
    const shown = await inspection.diff({ commit });
    expect(shown.text).toContain("initial");
    const log = await inspection.log({});
    expect(log.commits[0]?.subject).toBe("initial");
    const file = await inspection.fileAtRevision({ revision: "HEAD", path: "a.txt" });
    expect("content" in file ? file.content : "").toContain("one");
    const found = await inspection.searchText({ query: "two" });
    expect(found.matches.map((match) => match.path)).toContain("a.txt");
    expect(await markerExists()).toBe(false);
  });

  it("rejects option-like revisions and escaping paths", async () => {
    const inspection = makeGitInspection(await canonicalRoots([repo]));
    await expect(inspection.diff({ base: "--output=/tmp/x" })).rejects.toBeInstanceOf(
      InspectionError,
    );
    await expect(
      inspection.fileAtRevision({ revision: "HEAD", path: "../outside" }),
    ).rejects.toBeInstanceOf(InspectionError);
    expect(isSafeRevision("main~2")).toBe(true);
    expect(isSafeRevision("-p")).toBe(false);
    expect(isSafeRevision("main..evil")).toBe(false);
    expect(isSafeRevision("HEAD:secret")).toBe(false);
    expect(() => requireRelativeGitPath(":(top)x")).toThrow(InspectionError);
  });

  it("disables pagers, hooks, credential helpers, and optional index writes", () => {
    const argv = readOnlyGitArgv(["status"]);
    expect(argv).toContain("--no-pager");
    expect(argv).toContain("credential.helper=");
    expect(argv).toContain("core.fsmonitor=false");
    expect(argv.at(-1)).toBe("status");
    const env = readOnlyGitEnvironment(
      { PATH: "/bin", GIT_EXTERNAL_DIFF: "evil", GIT_DIR: "/elsewhere" },
      undefined,
    );
    expect(env.GIT_EXTERNAL_DIFF).toBeUndefined();
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("paginates text with explicit truncation markers", () => {
    const text = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n");
    // Below the minimum page size, so it is clamped to 1000 characters.
    const page = paginateText(text, { maxChars: 12 }, false);
    expect(page.truncated).toBe(true);
    expect(page.nextOffset).not.toBeNull();
    expect(page.text.endsWith("\n")).toBe(true);
    expect(paginateText(text, {}, true).sourceIncomplete).toBe(true);
  });
});
