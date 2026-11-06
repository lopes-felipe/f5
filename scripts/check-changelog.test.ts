import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  addsUnreleasedEntry,
  checkChangelog,
  exemptPath,
  readPullRequestFacts,
  unreleasedBullets,
  type PullRequestFacts,
  type PullRequestFile,
} from "./check-changelog.ts";
import type { Gh } from "./lib/github-cli.ts";

const changelog = (unreleased: string[], released: string[] = ["- Shipped thing."]) =>
  [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    ...unreleased,
    "",
    "## [0.1.4] - 2026-11-05",
    "",
    "### Added",
    "",
    ...released,
    "",
  ].join("\n");
const base = changelog([]);
const changelogFile = { filename: "CHANGELOG.md", status: "modified" };
const code = { filename: "apps/web/src/main.ts" };
const facts = (files: PullRequestFile[], overrides: Partial<PullRequestFacts> = {}) =>
  checkChangelog({
    headRef: "fix/thing",
    author: "contributor",
    sameRepository: true,
    labels: [],
    files,
    ...overrides,
  });
const withChangelog = (after: string, before = base) => ({ changelog: { before, after } });

describe("exemptPath", () => {
  it.each([
    "docs/release.md",
    "docs/computer-certification/report.json",
    ".github/workflows/ci.yml",
    "upstream/ledger.json",
    "apps/server/src/git/GitCore.test.ts",
    "apps/server/src/git/GitCore.logic.test.ts",
    "apps/web/src/ChatView.test.tsx",
    "apps/web/src/ChatView.browser.tsx",
    "apps/desktop/scripts/electron-launcher.test.mjs",
    "apps/server/integration/TestProviderAdapter.integration.ts",
    "apps/server/integration/fixtures/repo.json",
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
    "apps/server/src/integration/client.ts",
  ])("does not exempt %s", (path) => expect(exemptPath(path)).toBe(false));
});

describe("unreleased entries", () => {
  it("reads only top-level bullets under ## [Unreleased]", () => {
    expect(
      unreleasedBullets(changelog(["### Fixed", "", "- New fix.", "  - detail"], ["- Old."])),
    ).toEqual(["- New fix."]);
    expect(unreleasedBullets("# Changelog\n\n- Stray bullet.\n")).toEqual([]);
  });

  it("counts a new Unreleased bullet", () => {
    expect(addsUnreleasedEntry(base, changelog(["- Fixed a thing users saw."]))).toBe(true);
  });

  it.each([
    ["a bullet added under a released heading", changelog([], ["- Shipped thing.", "- Late."])],
    ["a wording fix to a released bullet", changelog([], ["- Shipped thing, reworded."])],
    ["an empty bullet", changelog(["- "])],
    ["a heading without a bullet", changelog(["### Fixed"])],
  ])("ignores %s", (_label, after) => expect(addsUnreleasedEntry(base, after)).toBe(false));

  it("ignores reordering or moving an existing bullet into Unreleased", () => {
    const before = changelog(["- First.", "- Second."]);
    expect(addsUnreleasedEntry(before, changelog(["- Second.", "- First."]))).toBe(false);
    expect(addsUnreleasedEntry(base, changelog(["- Shipped thing."], []))).toBe(false);
  });
});

describe("checkChangelog", () => {
  it("passes a code change with a new Unreleased entry", () => {
    const verdict = facts([code, changelogFile], withChangelog(changelog(["- Fixed it."])));
    expect(verdict).toEqual({
      ok: true,
      reason: "CHANGELOG.md adds an entry under ## [Unreleased].",
    });
  });

  it("fails a code change without an entry and names the label", () => {
    const verdict = facts([code]);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('"no-changelog" label');
  });

  it("fails a code change whose changelog edit only touches a released section", () => {
    const after = changelog([], ["- Shipped thing, reworded."]);
    expect(facts([code, changelogFile], withChangelog(after)).ok).toBe(false);
  });

  it("passes a PR that only edits the changelog, even without a new bullet", () => {
    const after = changelog([], []);
    expect(facts([changelogFile], withChangelog(after)).ok).toBe(true);
    expect(facts([changelogFile, { filename: "docs/release.md" }], withChangelog(after)).ok).toBe(
      true,
    );
  });

  it("passes with the no-changelog label", () => {
    expect(facts([code], { labels: ["no-changelog"] }).ok).toBe(true);
  });

  it.each([
    { headRef: "dependabot/npm/vite-8", author: "dependabot[bot]" },
    { headRef: "release/prepare-abc", author: "f5-release-automation-lopes-felipe[bot]" },
    { headRef: "f5/upstream-ledger-20261103", author: "lopes-felipe" },
  ])("passes the automation branch $headRef", (overrides) =>
    expect(facts([code], overrides).ok).toBe(true),
  );

  it.each([
    { headRef: "dependabot/npm/vite-8", author: "contributor" },
    { headRef: "release/prepare-abc", author: "contributor" },
    { headRef: "f5/upstream-ledger-x", author: "lopes-felipe", sameRepository: false },
    { headRef: "dependabot/npm/vite-8", author: "dependabot[bot]", sameRepository: false },
  ])("does not trust $headRef from $author (same repo: $sameRepository)", (overrides) =>
    expect(facts([code], overrides).ok).toBe(false),
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

  it("does not let a file renamed to CHANGELOG.md stand in for an entry", () => {
    const renamed = { filename: "CHANGELOG.md", previous_filename: "apps/web/src/notes.ts" };
    expect(facts([renamed], withChangelog(changelog([]), "")).ok).toBe(false);
  });

  it("never treats an empty or truncated file list as exempt", () => {
    expect(facts([]).ok).toBe(false);
    expect(
      facts(Array.from({ length: 3000 }, (_, index) => ({ filename: `docs/${index}.md` }))).ok,
    ).toBe(false);
  });
});

describe("readPullRequestFacts", () => {
  const pull = {
    user: { login: "contributor" },
    head: { ref: "fix/x", sha: "head-sha", repo: { full_name: "fork/r" } },
    base: { sha: "base-sha", repo: { full_name: "o/r" } },
    labels: [{ name: "no-changelog" }],
  };

  function harness(files: PullRequestFile[][], contents: Record<string, string | null>) {
    return vi.fn<Gh>(async (args) => {
      const path = args.at(-1)!;
      if (path === "repos/o/r/pulls/9") return JSON.stringify(pull);
      if (path === "repos/o/r/pulls/9/files?per_page=100") {
        expect(args).toContain("--paginate");
        return JSON.stringify(files);
      }
      const ref = /^repos\/o\/r\/contents\/CHANGELOG\.md\?ref=(.+)$/.exec(path)?.[1];
      if (ref !== undefined && ref in contents) {
        expect(args).toContain("Accept: application/vnd.github.raw");
        const content = contents[ref];
        if (content === null) throw new Error("gh api exited 1: HTTP 404: Not Found");
        return content ?? "";
      }
      throw new Error("Unexpected API " + path);
    });
  }

  it("reads the author, fork status, labels, and every page of files", async () => {
    const gh = harness([[{ filename: "a.ts" }], [{ filename: "b.ts" }]], {});
    await expect(readPullRequestFacts("o/r", 9, gh)).resolves.toEqual({
      headRef: "fix/x",
      author: "contributor",
      sameRepository: false,
      labels: ["no-changelog"],
      files: [{ filename: "a.ts" }, { filename: "b.ts" }],
    });
  });

  it("reads CHANGELOG.md at both commits when the PR touches it", async () => {
    const gh = harness([[changelogFile]], { "base-sha": null, "head-sha": "after" });
    await expect(readPullRequestFacts("o/r", 9, gh)).resolves.toMatchObject({
      changelog: { before: "", after: "after" },
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
