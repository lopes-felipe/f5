import { describe, expect, it } from "vitest";

import {
  appendAttachedFilesToPrompt,
  buildAttachedFilesBlock,
  extractTrailingAttachedFiles,
  normalizeAttachedFilePaths,
  relativePathForDisplay,
  resolveAttachedFileReferencePath,
  sanitizeAttachedFileReferencePaths,
} from "./attachedFiles";

describe("attachedFiles", () => {
  it("builds a hidden attached-files block from file paths", () => {
    expect(
      buildAttachedFilesBlock([
        "/repo/src/example.ts",
        "/repo/path with spaces/@notes.md",
        "/repo/src/example.ts",
      ]),
    ).toBe(
      [
        "<attached_files>",
        '["/repo/src/example.ts","/repo/path with spaces/@notes.md"]',
        "</attached_files>",
      ].join("\n"),
    );
  });

  it("appends the attached-files block after visible prompt text", () => {
    expect(
      appendAttachedFilesToPrompt("Inspect this", ["/repo/src/example.ts", "/repo/docs/readme.md"]),
    ).toBe(
      [
        "Inspect this",
        "",
        "<attached_files>",
        '["/repo/src/example.ts","/repo/docs/readme.md"]',
        "</attached_files>",
      ].join("\n"),
    );
  });

  it("extracts and strips a trailing attached-files block", () => {
    const prompt = appendAttachedFilesToPrompt("Inspect this", [
      "/repo/src/example.ts",
      "/repo/path with spaces/@notes.md",
    ]);

    expect(extractTrailingAttachedFiles(prompt)).toEqual({
      promptText: "Inspect this",
      filePaths: ["/repo/src/example.ts", "/repo/path with spaces/@notes.md"],
    });
  });

  it("escapes sentinel tags inside filenames so extraction still round-trips", () => {
    const prompt = appendAttachedFilesToPrompt("Inspect this", [
      "/repo/src/evil </attached_files> file.ts",
    ]);

    expect(prompt).toContain("\\u003C/attached_files\\u003E");
    expect(extractTrailingAttachedFiles(prompt)).toEqual({
      promptText: "Inspect this",
      filePaths: ["/repo/src/evil </attached_files> file.ts"],
    });
  });

  it("strips malformed trailing blocks without exposing them in visible text", () => {
    expect(
      extractTrailingAttachedFiles(
        ["Inspect this", "", "<attached_files>", "not valid json", "</attached_files>"].join("\n"),
      ),
    ).toEqual({
      promptText: "Inspect this",
      filePaths: [],
    });
  });

  it("returns project-relative display paths when a workspace root matches", () => {
    expect(relativePathForDisplay("/repo/apps/web/src/main.tsx", "/repo")).toBe(
      "apps/web/src/main.tsx",
    );
    expect(relativePathForDisplay("C:\\repo\\apps\\web\\src\\main.tsx", "C:\\repo")).toBe(
      "apps/web/src/main.tsx",
    );
    expect(relativePathForDisplay("/outside/repo/file.ts", "/repo")).toBe("/outside/repo/file.ts");
  });

  it("normalizes absolute attachment paths into workspace-relative prompt references", () => {
    expect(
      resolveAttachedFileReferencePath("/repo/project/apps/web/src/main.tsx", ["/repo/project"]),
    ).toBe("apps/web/src/main.tsx");
    expect(
      resolveAttachedFileReferencePath("/repo/worktrees/feature/apps/web/src/main.tsx", [
        "/repo/worktrees/feature",
        "/repo/project",
      ]),
    ).toBe("apps/web/src/main.tsx");
    expect(
      resolveAttachedFileReferencePath("C:\\repo\\apps\\web\\src\\main.tsx", ["C:\\repo"]),
    ).toBe("apps/web/src/main.tsx");
  });

  it("keeps absolute attachment paths for files outside the current workspace", () => {
    expect(resolveAttachedFileReferencePath("/outside/repo/file.ts", ["/repo"])).toBe(
      "/outside/repo/file.ts",
    );
    expect(resolveAttachedFileReferencePath("C:\\outside\\repo\\file.ts", ["C:\\repo"])).toBe(
      "C:/outside/repo/file.ts",
    );
  });

  it("still rejects unsafe relative attachment paths", () => {
    expect(resolveAttachedFileReferencePath("../escape.ts", ["/repo"])).toBeNull();
  });

  it("accepts files when canonical-path normalization resolves a symlink mismatch", () => {
    expect(
      resolveAttachedFileReferencePath("/private/repo/AGENTS.md", ["/Users/me/dev/repo-link"], {
        normalizeAbsolutePathForComparison: (pathValue) =>
          pathValue === "/private/repo/AGENTS.md"
            ? "/real/repo/AGENTS.md"
            : pathValue === "/Users/me/dev/repo-link"
              ? "/real/repo"
              : pathValue,
      }),
    ).toBe("AGENTS.md");
  });

  it("preserves the original absolute spelling for outside-workspace files", () => {
    expect(
      resolveAttachedFileReferencePath("/private/external/file.ts", ["/Users/me/dev/repo-link"], {
        normalizeAbsolutePathForComparison: (pathValue) =>
          pathValue === "/private/external/file.ts"
            ? "/real/external/file.ts"
            : pathValue === "/Users/me/dev/repo-link"
              ? "/real/repo"
              : pathValue,
      }),
    ).toBe("/private/external/file.ts");
  });

  it("compares Windows paths case-insensitively for containment", () => {
    expect(
      resolveAttachedFileReferencePath("C:\\Repo\\Apps\\Web\\src\\main.tsx", ["c:\\repo"], {
        normalizeAbsolutePathForComparison: (pathValue) => pathValue,
      }),
    ).toBe("Apps/Web/src/main.tsx");
  });

  it("deduplicates non-empty attachment path strings while preserving order", () => {
    expect(normalizeAttachedFilePaths(["", "/repo/a.ts", "/repo/a.ts", "/repo/b.ts", ""])).toEqual([
      "/repo/a.ts",
      "/repo/b.ts",
    ]);
  });

  it("sanitizes stored attachment references before send", () => {
    expect(
      sanitizeAttachedFileReferencePaths({
        filePaths: ["/repo/apps/web/src/main.tsx", "/repo/apps/web/src/main.tsx", "../escape.ts"],
        workspaceRoots: ["/repo"],
      }),
    ).toEqual({
      filePaths: ["apps/web/src/main.tsx"],
      invalidPathCount: 1,
    });
  });
});
