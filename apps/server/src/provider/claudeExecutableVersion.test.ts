import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCliScript } from "../testUtils/cli.ts";
import {
  claudeVersionCacheKey,
  clearClaudeExecutableVersionCache,
  readClaudeExecutableVersion,
} from "./claudeExecutableVersion.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "f5-claude-version-"));
  clearClaudeExecutableVersionCache();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const versionScript = (name: string, version: string) =>
  writeCliScript(join(root, name), `process.stdout.write("${version} (Claude Code)\\n");`);

describe("readClaudeExecutableVersion", () => {
  it("keeps JavaScript entries that share one Node runtime apart", async () => {
    const current = versionScript("current", "2.1.317");
    const older = versionScript("older", "2.1.295");
    expect(await readClaudeExecutableVersion(current, process.env)).toBe("2.1.317");
    expect(await readClaudeExecutableVersion(older, process.env)).toBe("2.1.295");
    expect(
      claudeVersionCacheKey({ file: process.execPath, args: [current, "--version"] }),
    ).not.toBe(claudeVersionCacheKey({ file: process.execPath, args: [older, "--version"] }));
  });

  // File symlinks need elevated rights on Windows.
  it.skipIf(process.platform === "win32")(
    "re-reads after the script changes or a link points elsewhere",
    async () => {
      const script = versionScript("claude", "2.1.295");
      const link = join(root, "claude-link.cjs");
      symlinkSync(script, link);
      expect(await readClaudeExecutableVersion(link, process.env)).toBe("2.1.295");
      writeFileSync(
        script,
        `#!/usr/bin/env node\nprocess.stdout.write("2.1.317 (Claude Code) upgraded\\n");\n`,
      );
      expect(await readClaudeExecutableVersion(link, process.env)).toBe("2.1.317");
      const other = versionScript("other", "2.1.320");
      rmSync(link);
      symlinkSync(other, link);
      expect(await readClaudeExecutableVersion(link, process.env)).toBe("2.1.320");
    },
  );

  it("does not wait for a wrapper that reads stdin before answering", async () => {
    const reader = writeCliScript(
      join(root, "reader"),
      `process.stdin.resume(); process.stdin.on("end", () => process.exit(0));`,
    );
    const started = Date.now();
    expect(await readClaudeExecutableVersion(reader, process.env)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
