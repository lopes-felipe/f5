import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { museWorkspaceRoot, resolveMuseInvocation } from "./MusePaths.ts";

describe("Muse on Windows", () => {
  it("uses verbatim drive and UNC roots and preserves existing prefixes", async () => {
    expect(await museWorkspaceRoot("C:/missing-f5-muse/repo", "win32")).toBe(
      "\\\\?\\C:\\missing-f5-muse\\repo",
    );
    expect(await museWorkspaceRoot("//missing-f5-muse/share/repo", "win32")).toBe(
      "\\\\?\\UNC\\missing-f5-muse\\share\\repo",
    );
    expect(await museWorkspaceRoot("\\\\?\\C:\\missing-f5-muse", "win32")).toBe(
      "\\\\?\\C:\\missing-f5-muse",
    );
    expect(await museWorkspaceRoot("/workspace/repo", "linux")).toBe("/workspace/repo");
  });

  it("runs Muse's native cmd launcher under cmd.exe with its arguments intact", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "muse R&D "));
    try {
      const launcher = join(cwd, "muse.cmd");
      await writeFile(launcher, "@echo off\r\nmuse-native.exe %*\r\n");
      const invocation = await Effect.runPromise(
        resolveMuseInvocation(
          launcher,
          ["serve", "--no-session-log"],
          { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
          cwd,
          "win32",
        ),
      );
      expect(invocation).toEqual({
        file: "C:\\Windows\\System32\\cmd.exe",
        args: ["/d", "/c", "@", launcher, "serve", "--no-session-log"],
        kind: "native",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
