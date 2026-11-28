import { describe, expect, it } from "vitest";

import {
  buildFinalBranchName,
  buildPlaceholderBranchName,
  buildPullRequestBranchName,
  flattenLegacyPlaceholderBranchName,
  inferBranchType,
  isLegacyPlaceholderBranch,
  isPlaceholderBranch,
  normalizeBranchPrefix,
  slugifyBranchText,
} from "./branchNaming";

describe("normalizeBranchPrefix", () => {
  it.each([
    ["", "f5"],
    ["   ", "f5"],
    [undefined, "f5"],
    ["refs/heads/me/", "me"],
    ["Felipe Lopes", "felipe-lopes"],
    ["team/me", "team/me"],
    ["/team//me/", "team/me"],
    ["--odd__", "odd"],
  ])("normalizes %j to %s", (raw, expected) => {
    expect(normalizeBranchPrefix(raw)).toBe(expected);
  });
});

describe("slugifyBranchText", () => {
  it("drops stopwords and keeps the first five words", () => {
    expect(
      slugifyBranchText("Can you please fix the MCP import detection panel when it opens twice"),
    ).toBe("fix-mcp-import-detection-panel");
  });

  it("drops code fences, URLs, mentions and paths", () => {
    expect(
      slugifyBranchText(
        "@claude look at https://example.com/x and apps/web/src/a.tsx\n```ts\nconst secret = 1\n```\nsidebar flicker",
      ),
    ).toBe("look-at-sidebar-flicker");
  });

  it("folds accents and drops other non-ASCII", () => {
    expect(slugifyBranchText("Café menü 修正")).toBe("cafe-menu");
  });

  it("handles apostrophes in stopwords", () => {
    expect(slugifyBranchText("Let's add dark mode")).toBe("add-dark-mode");
  });

  it.each(["", "   ", "修正", "```only code```", "the a an"])(
    "falls back to new-thread for %j",
    (text) => {
      expect(slugifyBranchText(text)).toBe("new-thread");
    },
  );

  it("caps the slug at 48 characters on a word boundary", () => {
    const slug = slugifyBranchText(
      "internationalization localization accessibility responsiveness compatibility",
    );
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug).toBe("internationalization-localization-accessibility");
  });

  it("truncates a single overlong word", () => {
    expect(slugifyBranchText("x".repeat(80))).toBe("x".repeat(48));
  });
});

describe("buildPlaceholderBranchName", () => {
  it("builds prefix/wip/slug", () => {
    expect(
      buildPlaceholderBranchName({ prefix: "", sourceText: "MCP import detection panel" }),
    ).toBe("f5/wip/mcp-import-detection-panel");
    expect(buildPlaceholderBranchName({ prefix: "team/me", sourceText: null })).toBe(
      "team/me/wip/new-thread",
    );
  });

  it("is recognized as a placeholder", () => {
    expect(isPlaceholderBranch(buildPlaceholderBranchName({ sourceText: "hello world" }))).toBe(
      true,
    );
  });
});

describe("buildFinalBranchName", () => {
  it("uses the given type", () => {
    expect(buildFinalBranchName({ prefix: "", type: "fix", slug: "mcp import detect" })).toBe(
      "f5/fix/mcp-import-detect",
    );
  });

  it.each([
    ["f5/fix/login-redirect", "f5/fix/login-redirect"],
    ["t3code/login-redirect", "f5/fix/login-redirect"],
    ["refs/heads/f5/login-redirect", "f5/fix/login-redirect"],
    ["fix/login-redirect", "f5/fix/login-redirect"],
    ["wip/login-redirect", "f5/fix/login-redirect"],
  ])("strips echoed segments from %s", (slug, expected) => {
    expect(buildFinalBranchName({ prefix: "f5", type: "fix", slug })).toBe(expected);
  });

  it("uses an echoed type segment when no type is given", () => {
    expect(buildFinalBranchName({ slug: "refactor/worktree-names" })).toBe(
      "f5/refactor/worktree-names",
    );
    expect(buildFinalBranchName({ slug: "feature/sidebar-badges" })).toBe("f5/feat/sidebar-badges");
  });

  it("prefers a valid given type over an echoed one", () => {
    expect(buildFinalBranchName({ type: "perf", slug: "fix/slow-sidebar" })).toBe(
      "f5/perf/slow-sidebar",
    );
  });

  it.each([
    [undefined, "crash on startup", "fix"],
    ["bogus", "rename worktree helpers", "refactor"],
    [null, "readme install steps", "docs"],
    ["", "sidebar latency", "perf"],
    [undefined, "flaky composer specs", "test"],
    [undefined, "bump deps", "chore"],
    [undefined, "dark mode toggle", "feat"],
  ])("infers type when given %j for %s", (type, slug, expected) => {
    expect(buildFinalBranchName({ type, slug })).toBe(`f5/${expected}/${slug.replace(/ /g, "-")}`);
  });

  it("flattens nested slugs and caps length", () => {
    const name = buildFinalBranchName({ prefix: "me", type: "feat", slug: "ui/" + "y".repeat(80) });
    expect(name.startsWith("me/feat/ui")).toBe(true);
    expect(name.split("/")).toHaveLength(3);
    expect(name.split("/")[2]!.length).toBeLessThanOrEqual(48);
  });

  it("falls back to update for an empty slug", () => {
    expect(buildFinalBranchName({ type: "chore", slug: "  " })).toBe("f5/chore/update");
  });
});

describe("inferBranchType", () => {
  it("does not mistake substrings for keywords", () => {
    expect(inferBranchType("docker-special-cinema")).toBe("feat");
  });
});

describe("isPlaceholderBranch", () => {
  it.each([
    "t3code/abcd1234",
    "t3code-abcd1234",
    "t3code/f4ae4e0e-f971-4d48-b4f2-9cf0aa54ab12",
    "f5/wip/x",
    "team/me/wip/x-2",
    "f5/wip/mcp-import-detection-panel",
  ])("accepts %s", (branch) => {
    expect(isPlaceholderBranch(branch)).toBe(true);
  });

  it.each([
    "main",
    "wip/x",
    "f5/fix/x",
    "feature/wip-x",
    "f5/wip",
    "f5/wip/x/y",
    "t3code",
    "t3code-feature",
    "t3code-abcd1234-extra",
    "t3code/feature/demo",
  ])("rejects %s", (branch) => {
    expect(isPlaceholderBranch(branch)).toBe(false);
  });

  it("flattens legacy names into another legacy placeholder", () => {
    expect(flattenLegacyPlaceholderBranchName("t3code/abcd1234")).toBe("t3code-abcd1234");
    expect(isLegacyPlaceholderBranch("t3code-abcd1234")).toBe(true);
    expect(isLegacyPlaceholderBranch("f5/wip/x")).toBe(false);
  });
});

describe("buildPullRequestBranchName", () => {
  it("uses the prefix", () => {
    expect(buildPullRequestBranchName({ prefix: "", number: 91, headFragment: "main" })).toBe(
      "f5/pr-91/main",
    );
  });
});
