import { describe, expect, it } from "vitest";

import {
  asChangeKind,
  asSecuritySeverity,
  buildAreaAliasMap,
  combineCoverage,
  coverageOf,
  coverageOfCommits,
  maxSeverity,
  featureAreaPolicy,
  formatScoreParts,
  hasSecurityHint,
  isCoverageExcludedPath,
  kindFromSubject,
  laneOfKind,
  normalizeAreas,
  scoreUpstreamTopic,
  topicKindFromCommits,
} from "./upstreamPortsScore";

describe("kindFromSubject", () => {
  it.each([
    ["fix(web): keep focus", "fix"],
    ["feat: add the PR hub", "feat"],
    ["feat!: drop node 20", "feat"],
    ["perf(server): cache diffs", "perf"],
    ["refactor: split the store", "refactor"],
    ["chore: bump deps", "maintenance"],
    ["test: cover the queue", "maintenance"],
    ["docs: explain lanes", "maintenance"],
    ["ci: cache bun", "maintenance"],
    ["build: target es2023", "maintenance"],
    ["style: format", "maintenance"],
    ["revert: fix(web): keep focus", "revert"],
    ['Revert "fix(web): keep focus"', "revert"],
    ["Fix the sidebar", null],
    ["wip: something", null],
  ] as const)("%s → %s", (subject, kind) => {
    expect(kindFromSubject(subject)).toBe(kind);
  });
});

describe("hasSecurityHint", () => {
  it("matches CVE and GHSA ids, vulnerabilities and named security fixes", () => {
    expect(hasSecurityHint("fix: bump ws for CVE-2026-12345")).toBe(true);
    expect(hasSecurityHint("chore(deps): GHSA-abcd-1234-wxyz")).toBe(true);
    expect(hasSecurityHint("fix: path traversal vulnerability")).toBe(true);
    expect(hasSecurityHint("chore: security patch for electron")).toBe(true);
    expect(hasSecurityHint("chore: bump", "Addresses a security advisory in undici")).toBe(true);
  });

  it("ignores ordinary mentions of security", () => {
    expect(hasSecurityHint("feat: security settings page")).toBe(false);
    expect(hasSecurityHint("fix: settings", "The security tab no longer flickers")).toBe(false);
  });
});

describe("topicKindFromCommits", () => {
  it("picks security first, then the highest-precedence prefix", () => {
    expect(
      topicKindFromCommits([{ subject: "feat: x" }, { subject: "fix: CVE-2026-0001 y" }]),
    ).toBe("security");
    expect(topicKindFromCommits([{ subject: "feat: x" }, { subject: "fix: y" }])).toBe("fix");
    expect(topicKindFromCommits([{ subject: "perf: x" }, { subject: "feat: y" }])).toBe("feat");
    expect(topicKindFromCommits([{ subject: "chore: x" }, { subject: "refactor: y" }])).toBe(
      "refactor",
    );
    expect(topicKindFromCommits([{ subject: "chore: x" }])).toBe("maintenance");
  });

  it("counts unconventional subjects as fixes", () => {
    expect(
      topicKindFromCommits([{ subject: "chore: x" }, { subject: "Make the sidebar faster" }]),
    ).toBe("fix");
    expect(topicKindFromCommits([])).toBe("fix");
  });
});

it("validates model kinds and severities", () => {
  expect(asChangeKind("perf")).toBe("perf");
  expect(asChangeKind("bugfix")).toBeNull();
  expect(asChangeKind(null)).toBeNull();
  expect(asSecuritySeverity("critical")).toBe("critical");
  expect(asSecuritySeverity("severe")).toBeNull();
});

describe("coverage", () => {
  it("ignores tests, docs, snapshots and lockfiles", () => {
    for (const path of [
      "bun.lock",
      "apps/web/src/a.test.ts",
      "apps/web/src/a.browser.tsx",
      "apps/web/src/__snapshots__/a.snap",
      "docs/user/x.md",
      "README.md",
      "apps/server/test/fixtures.ts",
    ])
      expect(isCoverageExcludedPath(path), path).toBe(true);
    expect(isCoverageExcludedPath("apps/web/src/a.ts")).toBe(false);
  });

  it("reports all, partial, none, or null without source files", () => {
    const file = (path: string, existsInFork: boolean) => ({ path, existsInFork });
    expect(coverageOf([file("a.ts", true), file("a.test.ts", false)])).toBe("all");
    expect(coverageOf([file("a.ts", true), file("b.ts", false)])).toBe("partial");
    expect(coverageOf([file("a.ts", false), file("bun.lock", true)])).toBe("none");
    expect(coverageOf([file("docs/a.md", true)])).toBeNull();
    expect(combineCoverage(["none", "none"])).toBe("none");
    expect(combineCoverage(["all", "none"])).toBe("partial");
    expect(combineCoverage([null, undefined])).toBeNull();
  });

  it("never reports all while a commit's files are unknown", () => {
    const file = (path: string, existsInFork: boolean) => ({ path, existsInFork });
    expect(combineCoverage(["all", null, "all"])).toBeNull();
    expect(combineCoverage(["all", undefined])).toBeNull();
    expect(coverageOfCommits([{ files: [file("a.ts", true)] }, { files: null }])).toBeNull();
    // A commit that changed only docs or tests says nothing either way.
    expect(
      coverageOfCommits([{ files: [file("a.ts", true)] }, { files: [file("docs/a.md", false)] }]),
    ).toBe("all");
    expect(coverageOfCommits([])).toBeNull();
  });

  it("keeps the more severe security severity", () => {
    expect(maxSeverity("low", "critical")).toBe("critical");
    expect(maxSeverity("high", undefined)).toBe("high");
    expect(maxSeverity(undefined, undefined)).toBeUndefined();
  });
});

describe("areas", () => {
  const aliases = buildAreaAliasMap([
    { key: "pr-hub", label: "PR Hub", aliases: ["pr hub", "Pull Requests"] },
    { key: "providers", label: "Providers", aliases: ["claude", "codex"] },
  ]);

  it("normalizes names through the alias map and keeps unknown ones squashed", () => {
    expect(
      normalizeAreas(["PR Hub", "pull requests", "Claude", "Model Picker", " "], aliases),
    ).toEqual(["pr-hub", "providers", "model-picker"]);
  });

  it("follows when any area is followed and ignores only when all are", () => {
    expect(featureAreaPolicy(["pr-hub", "git"], { git: "follow" })).toBe("follow");
    expect(featureAreaPolicy(["pr-hub", "git"], { git: "ignore" })).toBe("fixes-only");
    expect(featureAreaPolicy(["pr-hub", "git"], { git: "ignore", "pr-hub": "ignore" })).toBe(
      "ignore",
    );
    expect(featureAreaPolicy([], {})).toBe("fixes-only");
  });
});

describe("scoreUpstreamTopic", () => {
  it.each([
    [{ kind: "security", severity: "critical" }, "security", 100],
    [{ kind: "security", impact: "low", coverage: "none" }, "security", 35],
    [{ kind: "fix", impact: "high", coverage: "all" }, "bug", 85],
    [{ kind: "revert", impact: "medium" }, "bug", 55],
    [{ kind: "fix", impact: "low", coverage: "none" }, "bug", 20],
    [{ kind: "perf", impact: "medium", coverage: "partial" }, "perf", 55],
    [{ kind: "feat", featurePolicy: "follow", impact: "medium" }, "feature", 55],
    [{ kind: "feat", impact: "medium" }, "feature", 30],
    // Fixes-only features stay below the shortlist threshold of 50.
    [{ kind: "feat", impact: "high", coverage: "all" }, "feature", 49],
    [{ kind: "feat", featurePolicy: "follow", impact: "high", coverage: "all" }, "feature", 85],
    [{ kind: "feat", featurePolicy: "ignore", impact: "none" }, "feature", 0],
    [{ kind: "refactor", impact: "none", suggestionStatus: "skip" }, "maintenance", 0],
    [{ kind: "fix", impact: "high", suggestionStatus: "watch" }, "bug", 60],
  ] as const)("%o → %s %i", (input, lane, score) => {
    expect(scoreUpstreamTopic(input)).toMatchObject({ lane, score });
  });

  it("explains the score with the base first and non-zero adjustments", () => {
    const result = scoreUpstreamTopic({
      kind: "fix",
      impact: "high",
      coverage: "none",
      suggestionStatus: "port",
    });
    expect(formatScoreParts(result.parts)).toBe(
      "Bug 40 · high impact +30 · files missing in f5 −20",
    );
  });

  it("maps every kind to a lane", () => {
    expect(laneOfKind("maintenance")).toBe("maintenance");
    expect(laneOfKind("security")).toBe("security");
  });
});
