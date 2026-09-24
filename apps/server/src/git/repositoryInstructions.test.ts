import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it, expect } from "vitest";
import { repositoryWritingPreferences } from "./repositoryInstructions.ts";

it("includes root instructions and Claude guidance only for the Claude writer", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "f5-writing-"));
  try {
    await writeFile(path.join(cwd, "AGENTS.md"), "Use repository commit conventions.");
    await writeFile(path.join(cwd, "CLAUDE.md"), "Claude writing guidance.");
    expect((await repositoryWritingPreferences(cwd, "codex")).customInstructions).toContain(
      "Use repository commit conventions.",
    );
    expect((await repositoryWritingPreferences(cwd, "codex")).customInstructions).not.toContain(
      "Claude writing guidance.",
    );
    expect((await repositoryWritingPreferences(cwd, "claudeAgent")).customInstructions).toContain(
      "Claude writing guidance.",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it("ignores oversized instructions and symlinks escaping the repository", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "f5-writing-"));
  const cwd = await mkdtemp(path.join(root, "repo-"));
  try {
    await writeFile(path.join(cwd, "AGENTS.md"), "x".repeat(20_001));
    await writeFile(path.join(root, "private.md"), "outside");
    await symlink(path.join(root, "private.md"), path.join(cwd, "CLAUDE.md"));
    expect((await repositoryWritingPreferences(cwd, "claudeAgent")).customInstructions).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
