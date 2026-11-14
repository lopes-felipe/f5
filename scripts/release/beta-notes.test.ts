import { afterEach, describe, expect, it } from "vitest";
import { emptyGroups, parseSection } from "../lib/changelog-fragments.ts";
import { createGitFixture, type GitFixture } from "../lib/git-fixture.ts";
import { releaseChangelog } from "../prepare-release.ts";
import { betaReleaseNotes, collectBetaChanges, previousReleaseTag } from "./beta-notes.ts";

const RUN = "https://github.com/o/r/actions/runs/7";

describe("betaReleaseNotes", () => {
  it("groups fragments and legacy entries by category, keeping provenance last", () => {
    expect(
      betaReleaseNotes({
        previousTag: "v0.2.0-beta.3",
        legacy: parseSection(["### Fixed", "", "- Legacy fix."]),
        fragments: [
          { path: "changes/fixed/b.md", category: "fixed", entries: ["- Fragment fix."] },
          { path: "changes/added/a.md", category: "added", entries: ["- Added thing."] },
        ],
        sourceSha: "abc123",
        runUrl: RUN,
      }),
    ).toBe(
      [
        "Changes since v0.2.0-beta.3.",
        "",
        "### Added",
        "",
        "- Added thing.",
        "",
        "### Fixed",
        "",
        "- Legacy fix.",
        "- Fragment fix.",
        "",
        "Automated beta from abc123.",
        "",
        "Source and validation: " + RUN,
        "",
      ].join("\n"),
    );
  });

  it("says when nothing user-visible changed", () => {
    const notes = (previousTag: string | undefined) =>
      betaReleaseNotes({
        previousTag,
        legacy: emptyGroups(),
        fragments: [],
        sourceSha: "s",
        runUrl: RUN,
      });
    expect(notes("v0.2.0")).toBe(
      "No user-visible changes since v0.2.0.\n\nAutomated beta from s.\n\nSource and validation: " +
        RUN +
        "\n",
    );
    expect(notes(undefined)).toMatch(/^No user-visible changes\.\n/);
  });

  it("describes the first beta without a previous release", () => {
    const notes = betaReleaseNotes({
      previousTag: undefined,
      legacy: emptyGroups(),
      fragments: [{ path: "changes/added/a.md", category: "added", entries: ["- A."] }],
      sourceSha: "s",
      runUrl: RUN,
    });
    expect(notes).toMatch(/^Changes in this beta\.\n\n### Added\n\n- A\.\n/);
  });
});

describe("previousReleaseTag", () => {
  const releases = [
    { tag_name: "v0.2.0-beta.5", draft: true },
    { tag_name: "v0.2.0-beta.4", draft: false },
    { tag_name: "v0.2.0-beta.2", draft: false },
    { tag_name: "v0.1.0", draft: false },
    { tag_name: "v0.2.0-beta.6", draft: false },
    { tag_name: "nightly", draft: false },
  ];

  it("picks the newest published ancestor other than the candidate", () => {
    expect(previousReleaseTag(releases, "v0.2.0-beta.6", () => true)).toBe("v0.2.0-beta.4");
    expect(previousReleaseTag(releases, "v0.2.0-beta.6", (tag) => tag !== "v0.2.0-beta.4")).toBe(
      "v0.2.0-beta.2",
    );
  });

  it("returns undefined when no published release is an ancestor", () => {
    expect(previousReleaseTag(releases, "v0.2.0-beta.6", () => false)).toBeUndefined();
  });
});

// Real git history: each command spawns git, which is slow under load.
describe("collectBetaChanges", { timeout: 60_000 }, () => {
  const fixtures: GitFixture[] = [];
  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.cleanup();
  });

  function setup() {
    const fixture = createGitFixture("beta-notes-");
    fixtures.push(fixture);
    const show = (rev: string, path: string) => {
      try {
        return fixture.git(["show", rev + ":" + path]);
      } catch {
        return undefined;
      }
    };
    const collect = (sourceSha: string, previousTag: string | undefined) => {
      const warnings: string[] = [];
      const changes = collectBetaChanges({
        sourceSha,
        previousTag,
        git: fixture.git,
        show,
        warn: (message) => warnings.push(message),
      });
      return { ...changes, warnings };
    };
    return { fixture, collect };
  }

  it("lists only fragments added after the previous published release", () => {
    const { fixture, collect } = setup();
    fixture.write(
      "CHANGELOG.md",
      "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-01\n\n- Old.\n",
    );
    fixture.write("changes/README.md", "# Fragments\n");
    fixture.write("changes/fixed/shipped-in-beta-1.md", "- Shipped in beta 1.\n");
    fixture.commit("beta 1", 1_000);
    fixture.git(["tag", "v0.2.0-beta.1"]);
    fixture.write("changes/added/superseded.md", "- Built into an unpublished beta.\n");
    fixture.commit("superseded beta 2", 2_000);
    fixture.git(["tag", "v0.2.0-beta.2"]);
    fixture.write("changes/fixed/later.md", "- Later fix.\n");
    fixture.write("changes/fixed/broken.md", "Prose.\n");
    const head = fixture.commit("beta 3", 3_000);

    // beta.2 was never published, so the published beta.1 is the previous release.
    const changes = collect(head, "v0.2.0-beta.1");
    expect(changes.fragments.map((fragment) => fragment.path)).toEqual([
      "changes/added/superseded.md",
      "changes/fixed/later.md",
    ]);
    expect(changes.warnings).toEqual([expect.stringContaining("changes/fixed/broken.md")]);

    // Without any previous release, every fragment counts.
    expect(collect(head, undefined).fragments.map((fragment) => fragment.path)).toEqual([
      "changes/fixed/shipped-in-beta-1.md",
      "changes/added/superseded.md",
      "changes/fixed/later.md",
    ]);
  });

  it("never repeats fragments folded into a stable release", () => {
    const { fixture, collect } = setup();
    fixture.write("CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n");
    fixture.write("changes/README.md", "# Fragments\n");
    fixture.write("changes/fixed/in-stable.md", "- In stable.\n");
    fixture.commit("work", 1_000);
    releaseChangelog(fixture.root, "0.2.0", "2026-11-14");
    fixture.commit("Release 0.2.0", 2_000);
    fixture.git(["tag", "v0.2.0"]);
    fixture.write("changes/changed/after-stable.md", "- After stable.\n");
    const head = fixture.commit("next", 3_000);

    const changes = collect(head, "v0.2.0");
    expect(changes.fragments.map((fragment) => fragment.path)).toEqual([
      "changes/changed/after-stable.md",
    ]);
    expect(changes.legacy.known.size).toBe(0);
  });

  it("includes Unreleased bullets added to CHANGELOG.md since the previous release", () => {
    const { fixture, collect } = setup();
    fixture.write("CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Old.\n");
    fixture.commit("beta 1", 1_000);
    fixture.git(["tag", "v0.2.0-beta.1"]);
    fixture.write(
      "CHANGELOG.md",
      "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Old.\n- Legacy new.\n",
    );
    const head = fixture.commit("legacy entry", 2_000);

    const changes = collect(head, "v0.2.0-beta.1");
    expect(changes.legacy.known.get("fixed")).toEqual(["- Legacy new."]);
    expect(changes.fragments).toEqual([]);
  });
});
