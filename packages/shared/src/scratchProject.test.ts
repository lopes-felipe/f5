import { describe, expect, it } from "vitest";

import { isScratchProject, isScratchThreadFolder, scratchThreadFolderName } from "./scratchProject";

describe("scratch project helpers", () => {
  it("names a thread folder from its date, first words and id", () => {
    expect(
      scratchThreadFolderName({
        threadId: "0F9E8D7C-1111-2222",
        createdAt: "2026-10-22T09:30:00.000Z",
        text: "Fix ../the LOGIN page, please! Then more words",
      }),
    ).toBe("2026-10-22-fix-the-login-page-please-0f9e8d7c");
    expect(
      scratchThreadFolderName({ threadId: "abc", createdAt: "2026-10-22T00:00:00Z", text: "日本" }),
    ).toBe("2026-10-22-abc");
    const long = scratchThreadFolderName({
      threadId: "id",
      createdAt: "2026-10-22T00:00:00Z",
      text: "a".repeat(500),
    });
    expect(long.length).toBeLessThanOrEqual(10 + 1 + 48 + 1 + 8);
  });

  it("keeps a creation time that is not a date out of the folder name", () => {
    for (const createdAt of ["../../evil", "2026/10/22", "..\\..\\x", ""])
      expect(scratchThreadFolderName({ threadId: "abc", createdAt, text: "Fix it" })).toBe(
        "fix-it-abc",
      );
  });

  it("accepts only one folder level directly under the root", () => {
    expect(isScratchThreadFolder("/state/scratch", "/state/scratch/2026-10-22-x-id")).toBe(true);
    expect(isScratchThreadFolder("/state/scratch/", "/state/scratch/2026-10-22-x-id")).toBe(true);
    expect(isScratchThreadFolder("C:\\s\\scratch", "C:\\s\\scratch\\2026-10-22-x-id")).toBe(true);
    for (const path of [
      "/state/scratch",
      "/state/scratch/",
      "/state/scratch/..",
      "/state/scratch/a/b",
      "/state/scratch-other/x",
      "/state/scratchx",
      "/state/scratch/Upper",
      "/elsewhere/x",
    ])
      expect(isScratchThreadFolder("/state/scratch", path)).toBe(false);
  });

  it("recognizes only the scratch kind", () => {
    expect(isScratchProject({ kind: "scratch" })).toBe(true);
    expect(isScratchProject({ kind: "standard" })).toBe(false);
    expect(isScratchProject({})).toBe(false);
    expect(isScratchProject(null)).toBe(false);
  });
});
