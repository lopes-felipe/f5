import { afterEach, describe, expect, it } from "vitest";
import { emptyGroups, parseSection } from "../lib/changelog-fragments.ts";
import { createGitFixture, type GitFixture } from "../lib/git-fixture.ts";
import { releaseChangelog } from "../prepare-release.ts";
import {
  betaReleaseNotes,
  collectBetaChanges,
  isAncestorTag,
  previousReleaseTag,
  releaseNotesFor,
  stableReleaseNotes,
} from "./release-notes.ts";

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

  it("does not re-announce a beta's fragment folded back into Unreleased by a withdrawal", () => {
    const { fixture, collect } = setup();
    fixture.write("CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n");
    fixture.write("changes/README.md", "# Fragments\n");
    fixture.write("changes/fixed/shipped.md", "- Shipped in beta 1.\n");
    fixture.commit("beta 1", 1_000);
    fixture.git(["tag", "v0.2.0-beta.1"]);
    releaseChangelog(fixture.root, "0.2.0", "2026-11-14");
    fixture.commit("Release 0.2.0 (preparation merged)", 2_000);
    // Withdrawal strips the unpublished heading, so the folded bullet becomes Unreleased again.
    const withdrawn = fixture
      .git(["show", "HEAD:CHANGELOG.md"])
      .split("\n")
      .filter((line) => !line.startsWith("## [0.2.0] - "))
      .join("\n");
    fixture.write("CHANGELOG.md", withdrawn + "\n");
    fixture.commit("Withdraw 0.2.0", 3_000);
    fixture.write("changes/added/new.md", "- New after the withdrawal.\n");
    const head = fixture.commit("next", 4_000);

    const changes = collect(head, "v0.2.0-beta.1");
    expect(changes.legacy.known.get("fixed") ?? []).toEqual([]);
    expect(changes.fragments.map((fragment) => fragment.path)).toEqual(["changes/added/new.md"]);
  });

  it("lists a new entry in a fragment recreated at a path the previous release had", () => {
    const { fixture, collect } = setup();
    fixture.write("CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n");
    fixture.write("changes/README.md", "# Fragments\n");
    fixture.write("changes/fixed/startup.md", "- Startup fix in beta 1.\n");
    fixture.commit("beta 1", 1_000);
    fixture.git(["tag", "v0.2.0-beta.1"]);
    releaseChangelog(fixture.root, "0.2.0", "2026-11-14");
    fixture.commit("Release 0.2.0 (preparation merged)", 2_000);
    const withdrawn = fixture
      .git(["show", "HEAD:CHANGELOG.md"])
      .split("\n")
      .filter((line) => !line.startsWith("## [0.2.0] - "))
      .join("\n");
    fixture.write("CHANGELOG.md", withdrawn + "\n");
    fixture.write("changes/fixed/startup.md", "- Another startup fix.\n");
    const head = fixture.commit("withdraw, then a new fragment at the same path", 3_000);

    const changes = collect(head, "v0.2.0-beta.1");
    expect(changes.fragments).toEqual([
      { path: "changes/fixed/startup.md", category: "fixed", entries: ["- Another startup fix."] },
    ]);
    expect(changes.legacy.known.get("fixed") ?? []).toEqual([]);
  });

  it("does not re-announce a renamed or migrated entry", () => {
    const { fixture, collect } = setup();
    fixture.write(
      "CHANGELOG.md",
      "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Migrated from CHANGELOG.md.\n",
    );
    fixture.write("changes/fixed/old-name.md", "- Renamed later.\n");
    fixture.commit("beta 1", 1_000);
    fixture.git(["tag", "v0.2.0-beta.1"]);
    fixture.write("CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n");
    fixture.write("changes/fixed/migrated.md", "- Migrated from CHANGELOG.md.\n");
    // Move the fragment to another category and slug.
    fixture.write("changes/changed/new-name.md", "- Renamed later.\n");
    fixture.remove("changes/fixed/old-name.md");
    fixture.write("changes/fixed/fresh.md", "- Fresh.\n- Renamed later.\n");
    const head = fixture.commit("migrate and rename", 2_000);

    const changes = collect(head, "v0.2.0-beta.1");
    expect(changes.fragments).toEqual([
      { path: "changes/fixed/fresh.md", category: "fixed", entries: ["- Fresh."] },
    ]);
    expect(changes.legacy.known.size).toBe(0);
  });
});

describe("isAncestorTag", { timeout: 60_000 }, () => {
  const fixtures: GitFixture[] = [];
  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.cleanup();
  });
  const track = (fixture: GitFixture) => (fixtures.push(fixture), fixture);

  it("fetches a missing tag from origin, then answers ancestry", () => {
    const origin = track(createGitFixture("ancestor-origin-"));
    origin.write("a.txt", "a\n");
    origin.commit("tagged", 1_000);
    origin.git(["tag", "v0.1.0"]);
    origin.git(["switch", "-q", "-c", "side"]);
    origin.write("side.txt", "side\n");
    origin.commit("side", 2_000);
    origin.git(["tag", "v0.1.1-beta.1"]);
    origin.git(["switch", "-q", "main"]);
    origin.write("b.txt", "b\n");
    const head = origin.commit("head", 3_000);

    const local = track(createGitFixture("ancestor-local-"));
    local.git(["remote", "add", "origin", origin.root]);
    local.git(["fetch", "-q", "--no-tags", "origin", "main"]);
    expect(local.git(["tag", "--list"])).toBe("");

    expect(isAncestorTag("v0.1.0", head, local.git)).toBe(true);
    expect(local.git(["tag", "--list"])).toBe("v0.1.0");
    // A tag on another branch exists but is not an ancestor (merge-base exits 1).
    expect(isAncestorTag("v0.1.1-beta.1", head, local.git)).toBe(false);
  });

  it("rethrows git failures other than not-an-ancestor", () => {
    const failure = Object.assign(new Error("fatal: bad object"), { status: 128 });
    const git = (args: readonly string[]) => {
      if (args[0] === "merge-base") throw failure;
      return "";
    };
    expect(() => isAncestorTag("v0.1.0", "abc", git)).toThrow("bad object");
  });
});

describe("releaseNotesFor", { timeout: 60_000 }, () => {
  const fixtures: GitFixture[] = [];
  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.cleanup();
  });
  const showIn = (fixture: GitFixture) => (rev: string, path: string) => {
    try {
      return fixture.git(["show", rev + ":" + path]);
    } catch {
      return undefined;
    }
  };

  it("falls back to the provenance lines when git fails while building beta notes", () => {
    const warnings: string[] = [];
    const notes = releaseNotesFor({
      kind: "beta",
      version: "0.2.0-beta.2",
      sourceSha: "abc",
      runUrl: RUN,
      releases: [{ tag_name: "v0.2.0-beta.1", draft: false }],
      git: () => {
        throw new Error("git exploded");
      },
      show: () => undefined,
      warn: (message) => warnings.push(message),
    });
    expect(notes).toBe("Automated beta from abc.\n\nSource and validation: " + RUN + "\n");
    expect(warnings).toEqual([expect.stringContaining("git exploded")]);
  });

  it("builds beta notes from the previous published release", () => {
    const fixture = createGitFixture("release-notes-");
    fixtures.push(fixture);
    fixture.write("CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n");
    fixture.write("changes/fixed/old.md", "- Old.\n");
    fixture.commit("beta 1", 1_000);
    fixture.git(["tag", "v0.2.0-beta.1"]);
    fixture.write("changes/added/new.md", "- New.\n");
    const head = fixture.commit("beta 2", 2_000);

    expect(
      releaseNotesFor({
        kind: "beta",
        version: "0.2.0-beta.2",
        sourceSha: head,
        runUrl: RUN,
        releases: [
          { tag_name: "v0.2.0-beta.2", draft: true },
          { tag_name: "v0.2.0-beta.1", draft: false },
        ],
        git: fixture.git,
        show: showIn(fixture),
      }),
    ).toBe(
      "Changes since v0.2.0-beta.1.\n\n### Added\n\n- New.\n\nAutomated beta from " +
        head +
        ".\n\nSource and validation: " +
        RUN +
        "\n",
    );
  });

  it("uses the stable section verbatim, adding fragments that landed during preparation", () => {
    const fixture = createGitFixture("release-notes-");
    fixtures.push(fixture);
    const changelog =
      "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-11-14\n\n### Fixed\n\n- Folded\n  continued.\n\n## [0.1.0] - 2026-10-01\n\n- Old.\n";
    fixture.write("CHANGELOG.md", changelog);
    fixture.write("changes/README.md", "# Fragments\n");
    const prepared = fixture.commit("Release 0.2.0", 1_000);
    fixture.write("changes/added/late.md", "- Landed during preparation.\n");
    const merged = fixture.commit("merge with a late fragment", 2_000);
    const stable = (sourceSha: string) =>
      releaseNotesFor({
        kind: "stable",
        version: "0.2.0",
        sourceSha,
        runUrl: RUN,
        releases: [],
        git: fixture.git,
        show: showIn(fixture),
      });

    expect(stable(prepared)).toBe("### Fixed\n\n- Folded\n  continued.\n");
    expect(stable(merged)).toBe(
      "### Added\n\n- Landed during preparation.\n\n### Fixed\n\n- Folded\n  continued.\n",
    );
    expect(() => stableReleaseNotes("# Changelog\n", "0.2.0")).toThrow(/changelog entry missing/);
  });
});
