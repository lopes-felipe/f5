import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  addsChangelogEntry,
  checkChangelog,
  exemptPath,
  readPullRequestFacts,
  type PullRequestFile,
} from "./check-changelog.ts";
import type { Gh } from "./lib/github-cli.ts";

const entry = "@@ -5,2 +5,4 @@\n ## [Unreleased]\n+\n+- Fixed a thing users saw.\n";
const facts = (files: PullRequestFile[], overrides: { headRef?: string; labels?: string[] } = {}) =>
  checkChangelog({ headRef: "fix/thing", labels: [], files, ...overrides });
const code = { filename: "apps/web/src/main.ts" };

describe("exemptPath", () => {
  it.each([
    "docs/release.md",
    "docs/computer-certification/report.json",
    ".github/workflows/ci.yml",
    "upstream/ledger.json",
    "apps/server/src/git/GitCore.test.ts",
    "apps/web/src/ChatView.test.tsx",
    "apps/web/src/ChatView.browser.tsx",
    "README.md",
    "apps/server/AGENTS.md",
  ])("exempts %s", (path) => expect(exemptPath(path)).toBe(true));

  it.each([
    "CHANGELOG.md",
    "apps/web/src/main.ts",
    "package.json",
    "bun.lock",
    "scripts/check-changelog.ts",
    "apps/web/src/docs/page.ts",
  ])("does not exempt %s", (path) => expect(exemptPath(path)).toBe(false));
});

describe("addsChangelogEntry", () => {
  it("needs an added top-level bullet with text", () => {
    expect(addsChangelogEntry(entry)).toBe(true);
    expect(addsChangelogEntry("+## [0.1.5]\n+\n")).toBe(false);
    expect(addsChangelogEntry("-- Removed entry.\n")).toBe(false);
    expect(addsChangelogEntry("+- \n")).toBe(false);
    expect(addsChangelogEntry(" - Existing entry.\n")).toBe(false);
  });
});

describe("checkChangelog", () => {
  it("passes a code change with a changelog entry", () => {
    expect(facts([code, { filename: "CHANGELOG.md", patch: entry }]).ok).toBe(true);
  });

  it("fails a code change without an entry and names the label", () => {
    const verdict = facts([code]);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('"no-changelog" label');
  });

  it("fails when the changelog edit adds no bullet", () => {
    const verdict = facts([code, { filename: "CHANGELOG.md", patch: "-- Old entry.\n+- \n" }]);
    expect(verdict.ok).toBe(false);
  });

  it("trusts a changelog whose diff GitHub omitted, unless the file was removed", () => {
    expect(facts([code, { filename: "CHANGELOG.md", status: "modified" }]).ok).toBe(true);
    expect(facts([code, { filename: "CHANGELOG.md", status: "removed" }]).ok).toBe(false);
  });

  it("passes with the no-changelog label", () => {
    expect(facts([code], { labels: ["no-changelog"] }).ok).toBe(true);
  });

  it.each(["dependabot/npm/vite-8", "release/prepare-abc", "f5/upstream-ledger-20261103"])(
    "passes the exempt branch %s",
    (headRef) => expect(facts([code], { headRef }).ok).toBe(true),
  );

  it("still requires entries from upstream port branches", () => {
    expect(facts([code], { headRef: "f5/upstream-pr-24193" }).ok).toBe(false);
  });

  it("passes when every file is exempt", () => {
    expect(facts([{ filename: "docs/ci.md" }, { filename: "apps/web/src/a.test.ts" }]).ok).toBe(
      true,
    );
  });

  it("checks both sides of a rename", () => {
    expect(facts([{ filename: "docs/old.ts", previous_filename: "apps/web/src/old.ts" }]).ok).toBe(
      false,
    );
  });

  it("never treats an empty or truncated file list as exempt", () => {
    expect(facts([]).ok).toBe(false);
    expect(
      facts(Array.from({ length: 3000 }, (_, index) => ({ filename: `docs/${index}.md` }))).ok,
    ).toBe(false);
  });
});

describe("readPullRequestFacts", () => {
  it("reads labels, the head branch, and every page of files", async () => {
    const gh = vi.fn<Gh>(async (args) => {
      const path = args.at(-1)!;
      if (path === "repos/o/r/pulls/9")
        return JSON.stringify({ head: { ref: "fix/x" }, labels: [{ name: "no-changelog" }] });
      if (path === "repos/o/r/pulls/9/files?per_page=100") {
        expect(args).toContain("--paginate");
        return JSON.stringify([[{ filename: "a.ts" }], [{ filename: "b.ts" }]]);
      }
      throw new Error("Unexpected API " + path);
    });
    await expect(readPullRequestFacts("o/r", 9, gh)).resolves.toEqual({
      headRef: "fix/x",
      labels: ["no-changelog"],
      files: [{ filename: "a.ts" }, { filename: "b.ts" }],
    });
  });
});

describe("changelog workflow", () => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/changelog.yml", import.meta.url), "utf8"),
  ) as {
    on: { pull_request: { types: string[]; paths?: unknown; "paths-ignore"?: unknown } };
    permissions: Record<string, string>;
    jobs: Record<string, { name: string; steps: { with?: Record<string, unknown> }[] }>;
  };

  it("reports a stable Changelog check on every PR, including label changes", () => {
    expect(workflow.on.pull_request.types).toEqual(
      expect.arrayContaining(["opened", "synchronize", "reopened", "labeled", "unlabeled"]),
    );
    expect(workflow.on.pull_request.paths).toBeUndefined();
    expect(workflow.on.pull_request["paths-ignore"]).toBeUndefined();
    expect(Object.values(workflow.jobs).map((job) => job.name)).toEqual(["Changelog"]);
  });

  it("runs with read-only access and never persists credentials", () => {
    expect(workflow.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    const checkout = Object.values(workflow.jobs)[0]!.steps[0]!.with!;
    expect(checkout["persist-credentials"]).toBe(false);
  });
});
