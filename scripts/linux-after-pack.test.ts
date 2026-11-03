import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { removeSharedWriteAccess, default: afterPack } = require("./linux-after-pack.cjs") as {
  removeSharedWriteAccess(path: string): Promise<void>;
  default(context: { appOutDir: string }): Promise<void>;
};
const claudeRuntime = require("./verify-claude-runtime.cjs") as {
  verifyClaudeRuntime(context: { appOutDir: string }): void;
};

afterEach(() => vi.restoreAllMocks());

describe.skipIf(process.platform === "win32")("Linux afterPack", () => {
  it("removes shared write access only inside the packed app, preserving other mode bits", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "f5-after-pack-"));
    try {
      const appOutDir = join(root, "app");
      const modes = {
        "app/f5": [0o777, 0o755],
        "app/resources.pak": [0o666, 0o644],
        "app/chrome-sandbox": [0o4777, 0o4755],
        "app/resources/app.asar": [0o644, 0o644],
        "app/read-only": [0o444, 0o444],
        "outside/file": [0o666, 0o666],
      } as const;
      let sandboxSpecialBits = 0;
      await fs.mkdir(join(appOutDir, "resources"), { recursive: true });
      await fs.mkdir(join(appOutDir, "sticky-dir"));
      await fs.mkdir(join(root, "outside"));
      for (const [file, [before]] of Object.entries(modes)) {
        await fs.writeFile(join(root, file), "");
        await fs.chmod(join(root, file), before);
        if (file === "app/chrome-sandbox") {
          // Some host filesystems strip setuid on chmod; preserve it when supported.
          sandboxSpecialBits = (await fs.stat(join(root, file))).mode & 0o7000;
        }
      }
      await fs.chmod(appOutDir, 0o777);
      await fs.chmod(join(appOutDir, "resources"), 0o777);
      await fs.chmod(join(appOutDir, "sticky-dir"), 0o1777);
      await fs.chmod(join(root, "outside"), 0o777);
      await fs.symlink("../outside", join(appOutDir, "linked-dir"));
      await fs.symlink("../outside/file", join(appOutDir, "linked-file"));
      await fs.symlink("missing", join(appOutDir, "broken-link"));

      await removeSharedWriteAccess(appOutDir);
      await removeSharedWriteAccess(appOutDir);

      for (const [file, [, after]] of Object.entries(modes)) {
        const expected = file === "app/chrome-sandbox" ? sandboxSpecialBits | 0o755 : after;
        expect([file, (await fs.stat(join(root, file))).mode & 0o7777]).toEqual([file, expected]);
      }
      for (const dir of [appOutDir, join(appOutDir, "resources")]) {
        expect((await fs.stat(dir)).mode & 0o7777).toBe(0o755);
      }
      expect((await fs.stat(join(root, "outside"))).mode & 0o7777).toBe(0o777);
      expect((await fs.stat(join(appOutDir, "sticky-dir"))).mode & 0o7777).toBe(0o1755);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("runs the existing runtime verification before hardening permissions", async () => {
    const appOutDir = await fs.mkdtemp(join(tmpdir(), "f5-after-pack-"));
    try {
      await fs.chmod(appOutDir, 0o777);
      const verify = vi.spyOn(claudeRuntime, "verifyClaudeRuntime").mockImplementation(() => {});
      const context = { appOutDir };
      await afterPack(context);
      expect(verify).toHaveBeenCalledExactlyOnceWith(context);
      expect((await fs.stat(appOutDir)).mode & 0o7777).toBe(0o755);
    } finally {
      await fs.rm(appOutDir, { recursive: true, force: true });
    }
  });

  it("propagates runtime verification and filesystem failures", async () => {
    vi.spyOn(claudeRuntime, "verifyClaudeRuntime")
      .mockImplementation(() => {})
      .mockImplementationOnce(() => {
        throw new Error("runtime smoke failed");
      });
    await expect(afterPack({ appOutDir: "" })).rejects.toThrow("runtime smoke failed");
    await expect(afterPack({ appOutDir: "" })).rejects.toThrow();
  });
});
