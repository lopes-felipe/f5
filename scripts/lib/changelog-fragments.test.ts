import { afterEach, describe, expect, it } from "vitest";
import {
  fragmentBulletLinesAt,
  fragmentsAt,
  lineSet,
  newEntries,
  withoutExisting,
  parseFragmentPath,
  parseSection,
  readFragments,
  renderSection,
  splitEntries,
  validateFragment,
  unreleasedBullets,
  unreleasedGroups,
} from "./changelog-fragments.ts";
import { createGitFixture, type GitFixture } from "./git-fixture.ts";

const fixtures: GitFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});
const gitFixture = () => {
  const fixture = createGitFixture("changelog-fragments-");
  fixtures.push(fixture);
  return fixture;
};

describe("parseFragmentPath", () => {
  it("reads the category and slug", () => {
    expect(parseFragmentPath("changes/fixed/bridge-unicode-2.md")).toEqual({
      category: "fixed",
      slug: "bridge-unicode-2",
    });
  });

  it("skips the README", () => {
    expect(parseFragmentPath("changes/README.md")).toBeNull();
  });

  it.each([
    ["changes/bugs/x.md", /unknown category/],
    ["changes/fixed/Thing.md", /lowercase/],
    ["changes/fixed/-x.md", /lowercase/],
    ["changes/fixed/x.txt", /lowercase/],
    ["changes/fixed/ui/x.md", /one level deep/],
    ["changes/x.md", /one level deep/],
    ["docs/x.md", /not under changes/],
  ])("rejects %s", (path, message) => expect(() => parseFragmentPath(path)).toThrow(message));
});

describe("validateFragment", () => {
  const path = "changes/fixed/x.md";

  it("returns bullets with their continuation lines", () => {
    expect(
      validateFragment(path, "- First line\n  continues.\n\n  Second paragraph.\n- Another.\n"),
    ).toEqual(["- First line\n  continues.\n\n  Second paragraph.", "- Another."]);
  });

  it.each([
    ["", /empty/],
    ["\n\n", /empty/],
    ["### Fixed\n\n- x\n", /heading/],
    ["Fixed a thing.\n", /outside a "- " bullet/],
    ["- x\n\nA separate paragraph.\n", /outside a "- " bullet/],
    ["```\ncode\n```\n", /outside a "- " bullet/],
    ["- Example:\n  ~~~\n  sample\n", /unclosed code fence/],
    ["- Example:\n  ```\n", /unclosed code fence/],
    ["-\n", /outside a "- " bullet/],
  ])("rejects %j", (content, message) =>
    expect(() => validateFragment(path, content)).toThrow(message),
  );
});

describe("sections", () => {
  it("splits entries and drops blank lines between them", () => {
    expect(splitEntries(["", "- a", "  more", "", "", "- b", ""])).toEqual(["- a\n  more", "- b"]);
  });

  it("renders known categories in canonical order and unknown ones after", () => {
    const groups = parseSection([
      "",
      "Intro.",
      "",
      "### Fixed",
      "",
      "- Fix.",
      "",
      "### Notes",
      "- Note.",
      "### Added",
      "- Add.",
    ]);
    expect(renderSection(groups)).toBe(
      "Intro.\n\n### Added\n\n- Add.\n\n### Fixed\n\n- Fix.\n\n### Notes\n\n- Note.",
    );
  });

  it("keeps only entries the earlier changelog did not have", () => {
    const groups = parseSection(["### Fixed", "- Old.", "- New."]);
    expect(renderSection(newEntries(groups, lineSet("## [0.1.0]\n\n- Old.\n")))).toBe(
      "### Fixed\n\n- New.",
    );
  });

  it("keeps hard-wrapped bullets and fenced code blocks intact when re-rendered", () => {
    const lines = [
      "### Fixed",
      "",
      "- A long entry that was",
      "hard wrapped without indentation.",
      "- Another.",
      "",
      "```sh",
      "bun run thing",
      "",
      "echo done",
      "```",
      "- After the code.",
    ];
    expect(renderSection(parseSection(lines))).toBe(
      [
        "### Fixed",
        "",
        "- A long entry that was",
        "hard wrapped without indentation.",
        "- Another.",
        "",
        "```sh",
        "bun run thing",
        "",
        "echo done",
        "```",
        "",
        "- After the code.",
      ].join("\n"),
    );
  });

  it("closes a fence only on a matching marker with nothing after it", () => {
    expect(
      splitEntries(["- Example:", "  ~~~", "  ~~~literal", "  x", "  ~~~", "- Next."]),
    ).toEqual(["- Example:\n  ~~~\n  ~~~literal\n  x\n  ~~~", "- Next."]);
    // A shorter or different marker does not close a longer fence.
    expect(splitEntries(["- A:", "````", "```", "~~~~", "````", "- B."])).toEqual([
      "- A:\n````\n```\n~~~~\n````",
      "- B.",
    ]);
  });

  it("treats headings inside fenced examples as content", () => {
    const lines = ["### Fixed", "", "- Example:", "  ```md", "  ### Added", "  ```", "- After."];
    expect(renderSection(parseSection(lines))).toBe(lines.join("\n"));
    const changelog = [
      "# Changelog",
      "## [Unreleased]",
      "### Fixed",
      "- Example:",
      "  ```md",
      "  ## [example]",
      "  ```",
      "- New fix.",
      "## [0.1.0] - 2026-10-01",
      "- Old.",
    ].join("\n");
    expect(unreleasedBullets(changelog)).toEqual(["- Example:", "- New fix."]);
    expect(unreleasedGroups(changelog).known.get("fixed")).toEqual([
      "- Example:\n  ```md\n  ## [example]\n  ```",
      "- New fix.",
    ]);
  });

  it("keeps a fenced block directly below a bullet inside that bullet", () => {
    expect(splitEntries(["- Run:", "```", "x", "", "y", "```", "- Next."])).toEqual([
      "- Run:\n```\nx\n\ny\n```",
      "- Next.",
    ]);
  });

  it("drops fragment entries that already exist, and fragments left empty", () => {
    const fragments = [
      { path: "changes/fixed/a.md", category: "fixed" as const, entries: ["- Old.", "- New."] },
      { path: "changes/fixed/b.md", category: "fixed" as const, entries: ["- Old.\n  detail"] },
    ];
    expect(withoutExisting(fragments, new Set(["- Old."]))).toEqual([
      { path: "changes/fixed/a.md", category: "fixed", entries: ["- New."] },
    ]);
  });
});

describe("fragments at a revision", { timeout: 60_000 }, () => {
  it("reads, validates and orders the fragments and their bullet lines at a commit", () => {
    const fixture = gitFixture();
    fixture.write("changes/README.md", "# Fragments\n- not a fragment\n");
    fixture.write("changes/fixed/b.md", "- B.\n  more\n");
    fixture.commit("first", 1_000);
    fixture.write("changes/added/a.md", "- A.\n");
    fixture.write("changes/fixed/bad.md", "Prose.\n");
    const head = fixture.commit("second", 2_000);
    const show = (rev: string, path: string) => fixture.git(["show", rev + ":" + path]);
    const warnings: string[] = [];

    expect(
      fragmentsAt({ rev: head, git: fixture.git, show, warn: (m) => warnings.push(m) }),
    ).toEqual([
      { path: "changes/fixed/b.md", category: "fixed", entries: ["- B.\n  more"] },
      { path: "changes/added/a.md", category: "added", entries: ["- A."] },
    ]);
    expect(warnings).toEqual([expect.stringContaining("changes/fixed/bad.md")]);
    // The README's bullets are not entries.
    expect(fragmentBulletLinesAt(head, fixture.git).toSorted()).toEqual(["- A.", "- B."]);
    expect(fragmentBulletLinesAt(head + "~1", fixture.git)).toEqual(["- B."]);
  });

  it("returns no bullet lines when there are no fragments", () => {
    const fixture = gitFixture();
    fixture.write("README.md", "x\n");
    const head = fixture.commit("first", 1_000);
    expect(fragmentBulletLinesAt(head, fixture.git)).toEqual([]);
  });
});

describe("readFragments", { timeout: 60_000 }, () => {
  it("returns nothing without a changes folder", () => {
    const fixture = gitFixture();
    expect(readFragments(fixture.root)).toEqual([]);
  });

  it("orders fragments by the commit that added them, uncommitted last", () => {
    const fixture = gitFixture();
    fixture.write("changes/README.md", "# Fragments\n");
    fixture.write("changes/fixed/zebra.md", "- Zebra.\n");
    fixture.commit("first", 1_000);
    fixture.write("changes/added/alpha.md", "- Alpha.\n");
    fixture.write("changes/fixed/beta.md", "- Beta.\n");
    fixture.commit("second", 2_000);
    fixture.write("changes/changed/new.md", "- New.\n");
    fixture.write("changes/fixed/.DS_Store", "noise");

    expect(readFragments(fixture.root)).toEqual([
      { path: "changes/fixed/zebra.md", category: "fixed", entries: ["- Zebra."] },
      { path: "changes/added/alpha.md", category: "added", entries: ["- Alpha."] },
      { path: "changes/fixed/beta.md", category: "fixed", entries: ["- Beta."] },
      { path: "changes/changed/new.md", category: "changed", entries: ["- New."] },
    ]);
  });

  it("rejects stray files and invalid fragments", () => {
    const fixture = gitFixture();
    fixture.write("changes/notes.md", "- Stray.\n");
    expect(() => readFragments(fixture.root)).toThrow(/one level deep/);
    fixture.remove("changes/notes.md");
    fixture.write("changes/fixed/bad.md", "Prose.\n");
    expect(() => readFragments(fixture.root)).toThrow(/outside a "- " bullet/);
  });
});
