import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { isGitRepository } from "./isRepo.ts";

it("detects nested project folders without spawning Git and rejects missing paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f5-git-detection-"));
  try {
    const nested = path.join(root, "packages", "app");
    fs.mkdirSync(nested, { recursive: true });
    expect(isGitRepository(nested)).toBe(false);
    fs.mkdirSync(path.join(root, ".git"));
    expect(isGitRepository(nested)).toBe(true);
    expect(isGitRepository(path.join(nested, "missing"))).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
