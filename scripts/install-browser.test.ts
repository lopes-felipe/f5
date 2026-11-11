import { expect, it } from "vitest";
import { browserInstallArgs } from "./install-browser";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

it.skipIf(process.platform === "win32")(
  "runs through a symlinked entry point",
  () => {
    const directory = mkdtempSync(join(tmpdir(), "f5-browser-install-"));
    try {
      const link = join(directory, "install.ts");
      symlinkSync(fileURLToPath(new URL("./install-browser.ts", import.meta.url)), link);
      const result = spawnSync(process.execPath, [link, "--dry-run"], {
        encoding: "utf8",
        env: { ...process.env, GITHUB_ACTIONS: "true", RUNNER_OS: "Linux" },
        timeout: 15_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Install location:");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  20_000,
);

it("uses hosted Linux libraries without making browser setup depend on APT mirrors", () => {
  expect(browserInstallArgs({ GITHUB_ACTIONS: "true", RUNNER_OS: "Linux" })).toEqual([
    "install",
    "chromium",
  ]);
});

it.each([
  {},
  { CI: "true", RUNNER_OS: "Linux" },
  { GITHUB_ACTIONS: "true", RUNNER_OS: "Windows" },
  { GITHUB_ACTIONS: "true", RUNNER_OS: "macOS" },
])("retains OS dependency installation outside hosted Linux: %j", (environment) => {
  expect(browserInstallArgs(environment)).toEqual(["install", "--with-deps", "chromium"]);
});
