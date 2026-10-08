import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deleteClaudeSessionTranscript,
  resolveClaudeTranscriptCleanupDir,
} from "./claudeSessionCleanup.ts";

const SESSION = "0f8f2a52-5b0f-4c7e-9d7a-1a2b3c4d5e6f";
let root: string;

async function exists(path: string) {
  return NodeFs.stat(path).then(
    () => true,
    () => false,
  );
}

beforeEach(async () => {
  root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "f5-claude-cleanup-"));
});

afterEach(async () => {
  await NodeFs.rm(root, { recursive: true, force: true });
});

describe("deleteClaudeSessionTranscript", () => {
  it("removes the transcript and sidecar from the isolated dir only", async () => {
    const isolated = NodePath.join(root, "profile-a", ".claude");
    const other = NodePath.join(root, "home", ".claude");
    for (const configDir of [isolated, other]) {
      const project = NodePath.join(configDir, "projects", "-repo");
      await NodeFs.mkdir(NodePath.join(project, SESSION, "subagents"), { recursive: true });
      await NodeFs.writeFile(NodePath.join(project, `${SESSION}.jsonl`), "{}\n");
      await NodeFs.writeFile(NodePath.join(project, SESSION, "subagents", "a.jsonl"), "{}\n");
      await NodeFs.writeFile(NodePath.join(project, "keep.jsonl"), "{}\n");
    }

    const result = await deleteClaudeSessionTranscript({
      claudeConfigDir: isolated,
      sessionId: SESSION,
    });

    const isolatedProject = NodePath.join(isolated, "projects", "-repo");
    expect(result.removed.toSorted()).toEqual(
      [
        NodePath.join(isolatedProject, SESSION),
        NodePath.join(isolatedProject, `${SESSION}.jsonl`),
      ].toSorted(),
    );
    expect(await exists(NodePath.join(isolatedProject, `${SESSION}.jsonl`))).toBe(false);
    expect(await exists(NodePath.join(isolatedProject, "keep.jsonl"))).toBe(true);
    expect(await exists(NodePath.join(other, "projects", "-repo", `${SESSION}.jsonl`))).toBe(true);
    expect(await exists(NodePath.join(other, "projects", "-repo", SESSION))).toBe(true);
  });

  it("does not follow a symlinked sidecar", async () => {
    const configDir = NodePath.join(root, ".claude");
    const project = NodePath.join(configDir, "projects", "-repo");
    const outside = NodePath.join(root, "outside");
    await NodeFs.mkdir(project, { recursive: true });
    await NodeFs.mkdir(outside);
    await NodeFs.writeFile(NodePath.join(outside, "precious.txt"), "x");
    await NodeFs.symlink(outside, NodePath.join(project, SESSION));

    await deleteClaudeSessionTranscript({ claudeConfigDir: configDir, sessionId: SESSION });

    expect(await exists(NodePath.join(outside, "precious.txt"))).toBe(true);
    expect(await exists(NodePath.join(project, SESSION))).toBe(false);
  });

  it("is a no-op without a store and refuses non-UUID ids", async () => {
    await expect(
      deleteClaudeSessionTranscript({
        claudeConfigDir: NodePath.join(root, "none"),
        sessionId: SESSION,
      }),
    ).resolves.toEqual({ removed: [] });
    await expect(
      deleteClaudeSessionTranscript({ claudeConfigDir: root, sessionId: "../projects" }),
    ).rejects.toThrow("non-UUID");
  });
});

describe("resolveClaudeTranscriptCleanupDir", () => {
  const base = {
    userHomeDir: "/Users/me",
    serverConfigDir: "/Users/me/.claude",
    isolatedProfile: false,
    homePath: "",
  };

  it("refuses the default instance, which shares ~/.claude with the CLI", () => {
    expect(resolveClaudeTranscriptCleanupDir({ ...base, configDir: "/Users/me/.claude" })).toBe(
      undefined,
    );
    // Even a non-default config dir is not F5's unless F5 isolated it.
    expect(
      resolveClaudeTranscriptCleanupDir({ ...base, configDir: "/opt/claude-shared" }),
    ).toBeUndefined();
  });

  it("refuses an isolated instance that still points at a user store", () => {
    expect(
      resolveClaudeTranscriptCleanupDir({
        ...base,
        homePath: "/Users/me",
        configDir: "/Users/me/.claude",
      }),
    ).toBeUndefined();
    expect(
      resolveClaudeTranscriptCleanupDir({
        ...base,
        isolatedProfile: true,
        serverConfigDir: "/custom/claude",
        configDir: "/custom/claude",
      }),
    ).toBeUndefined();
  });

  it("allows a profile or homePath store F5 owns", () => {
    expect(
      resolveClaudeTranscriptCleanupDir({
        ...base,
        isolatedProfile: true,
        configDir: "/state/provider-homes/claude/.claude",
      }),
    ).toBe("/state/provider-homes/claude/.claude");
    expect(
      resolveClaudeTranscriptCleanupDir({
        ...base,
        homePath: "/work-home",
        configDir: "/work-home/.claude",
      }),
    ).toBe("/work-home/.claude");
  });
});
