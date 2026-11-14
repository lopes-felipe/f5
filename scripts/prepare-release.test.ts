import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Fragment } from "./lib/changelog-fragments.ts";
import { createGitFixture, type GitFixture } from "./lib/git-fixture.ts";
import {
  foldIntoRelease,
  prepareChangelog,
  refoldChangelog,
  releaseChangelog,
  splitShippedFragments,
  validateReleaseVersion,
} from "./prepare-release.ts";
it("enforces stable/beta canonical increasing versions", () => {
  for (const version of [
    "0.1.0-rc.1",
    "0.1.0-preview.1",
    "0.1.0",
    "0.0.9",
    "01.2.3",
    "0.2.0-beta.01",
  ])
    expect(() => validateReleaseVersion(version, "0.1.0")).toThrow();
  expect(() => validateReleaseVersion("0.2.0-beta.1", "0.1.0")).not.toThrow();
});
it("moves Unreleased only for stable", () => {
  const text = "# Changelog\n\n## [Unreleased]\n\nChanges\n\n## [0.0.1]\nOld\n";
  expect(prepareChangelog(text, "0.1.0", "2026-10-16")).toContain(
    "## [Unreleased]\n\n## [0.1.0] - 2026-10-16\n\nChanges",
  );
  expect(prepareChangelog(text, "0.1.0-beta.1", "2026-10-16")).toBe(text);
});

describe("prepareChangelog with fragments", () => {
  const changelog = (unreleased: string[]) =>
    [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      ...unreleased,
      "",
      "## [0.1.0] - 2026-10-01",
      "",
      "### Added",
      "",
      "- Shipped.",
      "",
    ].join("\n");
  const fragment = (category: Fragment["category"], ...entries: string[]): Fragment => ({
    path: `changes/${category}/${entries.length}.md`,
    category,
    entries,
  });

  it("writes fragments into the release section in canonical order", () => {
    const text = prepareChangelog(changelog([]), "0.2.0", "2026-11-14", [
      fragment("fixed", "- Fix one.", "- Fix two\n  continued."),
      fragment("added", "- Add."),
      fragment("security", "- Patch."),
    ]);
    expect(text).toBe(
      [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "## [0.2.0] - 2026-11-14",
        "",
        "### Added",
        "",
        "- Add.",
        "",
        "### Fixed",
        "",
        "- Fix one.",
        "- Fix two",
        "  continued.",
        "",
        "### Security",
        "",
        "- Patch.",
        "",
        "## [0.1.0] - 2026-10-01",
        "",
        "### Added",
        "",
        "- Shipped.",
        "",
      ].join("\n"),
    );
  });

  it("puts existing Unreleased entries before fragments and keeps unknown sections", () => {
    const text = prepareChangelog(
      changelog([
        "### Fixed",
        "",
        "- Old fix.",
        "",
        "### Notes",
        "",
        "- A note.",
        "",
        "### Changed",
        "",
        "- Old change.",
      ]),
      "0.2.0",
      "2026-11-14",
      [fragment("fixed", "- New fix."), fragment("added", "- New add.")],
    );
    expect(text).toContain(
      "## [0.2.0] - 2026-11-14\n\n### Added\n\n- New add.\n\n### Changed\n\n- Old change.\n\n" +
        "### Fixed\n\n- Old fix.\n- New fix.\n\n### Notes\n\n- A note.\n\n## [0.1.0]",
    );
    expect(text).toContain("## [Unreleased]\n\n## [0.2.0]");
  });

  it("leaves betas unchanged and still requires an Unreleased section", () => {
    const text = changelog(["- Pending."]);
    expect(prepareChangelog(text, "0.2.0-beta.3", "2026-11-14", [fragment("added", "- A.")])).toBe(
      text,
    );
    expect(() => prepareChangelog("# Changelog\n", "0.2.0", "2026-11-14")).toThrow(/Unreleased/);
  });

  it("keeps every entry exactly once across a withdrawal and a new preparation", () => {
    const first = prepareChangelog(
      changelog(["### Fixed", "", "- Legacy."]),
      "0.2.0",
      "2026-11-14",
      [fragment("fixed", "- From a fragment.")],
    );
    // Withdrawal strips the unpublished heading, folding its entries back into Unreleased.
    const withdrawn = first
      .split("\n")
      .filter((line) => !line.startsWith("## [0.2.0] - "))
      .join("\n");
    const second = prepareChangelog(withdrawn, "0.2.1", "2026-11-15", [
      fragment("added", "- Later."),
    ]);
    for (const entry of ["- Legacy.", "- From a fragment.", "- Later."])
      expect(second.split(entry).length - 1).toBe(1);
    expect(second).toContain(
      "## [0.2.1] - 2026-11-15\n\n### Added\n\n- Later.\n\n### Fixed\n\n- Legacy.\n- From a fragment.\n\n## [0.1.0]",
    );
  });
});

describe("releaseChangelog", { timeout: 60_000 }, () => {
  const fixtures: GitFixture[] = [];
  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.cleanup();
  });

  it("folds fragments into CHANGELOG.md and deletes them, keeping the README", () => {
    const fixture = createGitFixture("release-changelog-");
    fixtures.push(fixture);
    fixture.write(
      "CHANGELOG.md",
      "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-01\n\n- Old.\n",
    );
    fixture.write("changes/README.md", "# Fragments\n");
    fixture.write("changes/fixed/a.md", "- A.\n");
    fixture.commit("fragments", 1_000);

    expect(releaseChangelog(fixture.root, "0.2.0-beta.1", "2026-11-14")).toEqual([]);
    expect(existsSync(join(fixture.root, "changes/fixed/a.md"))).toBe(true);

    expect(releaseChangelog(fixture.root, "0.2.0", "2026-11-14")).toEqual(["changes/fixed/a.md"]);
    expect(existsSync(join(fixture.root, "changes/fixed/a.md"))).toBe(false);
    expect(existsSync(join(fixture.root, "changes/README.md"))).toBe(true);
    expect(readFileSync(join(fixture.root, "CHANGELOG.md"), "utf8")).toContain(
      "## [Unreleased]\n\n## [0.2.0] - 2026-11-14\n\n### Fixed\n\n- A.\n\n## [0.1.0]",
    );
  });

  it("changes nothing when a fragment is invalid", () => {
    const fixture = createGitFixture("release-changelog-");
    fixtures.push(fixture);
    const original = "# Changelog\n\n## [Unreleased]\n";
    fixture.write("CHANGELOG.md", original);
    fixture.write("changes/fixed/bad.md", "Prose.\n");
    expect(() => releaseChangelog(fixture.root, "0.2.0", "2026-11-14")).toThrow(/bullet/);
    expect(readFileSync(join(fixture.root, "CHANGELOG.md"), "utf8")).toBe(original);
  });

  it("adds fragments that landed while the last stable's preparation was open to that release", () => {
    const fixture = createGitFixture("release-changelog-");
    fixtures.push(fixture);
    fixture.write("CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n");
    fixture.write("changes/README.md", "# Fragments\n");
    fixture.write("changes/fixed/before-prep.md", "- Before preparation.\n");
    fixture.commit("work", 1_000);
    // The preparation branch folds the fragment; meanwhile another fragment lands on main.
    releaseChangelog(fixture.root, "0.2.0", "2026-11-14");
    fixture.write("changes/added/during-prep.md", "- During preparation.\n");
    fixture.commit("Release 0.2.0 merged together with a late fragment", 2_000);
    fixture.git(["tag", "v0.2.0"]);
    fixture.write("changes/changed/after.md", "- After the release.\n");
    fixture.commit("next", 3_000);

    expect(splitShippedFragments(fixture.root, []).shipped).toBeUndefined();
    releaseChangelog(fixture.root, "0.3.0", "2026-11-20");
    expect(readFileSync(join(fixture.root, "CHANGELOG.md"), "utf8")).toBe(
      [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "## [0.3.0] - 2026-11-20",
        "",
        "### Changed",
        "",
        "- After the release.",
        "",
        "## [0.2.0] - 2026-11-14",
        "",
        "### Added",
        "",
        "- During preparation.",
        "",
        "### Fixed",
        "",
        "- Before preparation.",
        "",
      ].join("\n"),
    );
  });

  it("refolds late fragments into an unpublished version for recovery", () => {
    const fixture = createGitFixture("release-changelog-");
    fixtures.push(fixture);
    fixture.write(
      "CHANGELOG.md",
      "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-11-14\n\n### Fixed\n\n- Folded.\n\n## [0.1.0] - 2026-10-01\n\n- Old.\n",
    );
    fixture.write("changes/fixed/late.md", "- Late.\n");
    fixture.commit("late", 1_000);
    expect(refoldChangelog(fixture.root, "0.2.0")).toEqual(["changes/fixed/late.md"]);
    expect(readFileSync(join(fixture.root, "CHANGELOG.md"), "utf8")).toContain(
      "## [0.2.0] - 2026-11-14\n\n### Fixed\n\n- Folded.\n- Late.\n\n## [0.1.0]",
    );
    expect(() => refoldChangelog(fixture.root, "9.9.9")).not.toThrow();
  });
});

describe("foldIntoRelease", () => {
  it("requires the release section when there is something to fold", () => {
    const fragment: Fragment = { path: "changes/fixed/a.md", category: "fixed", entries: ["- A."] };
    expect(foldIntoRelease("# Changelog\n", "0.2.0", [])).toBe("# Changelog\n");
    expect(() => foldIntoRelease("# Changelog\n", "0.2.0", [fragment])).toThrow(/0\.2\.0/);
  });
});
