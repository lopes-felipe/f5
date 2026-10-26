import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config";

// Provider/profile isolation and injected Git configuration belong to the running
// app, not its tests. Delete inherited values before Vitest snapshots its env.
const inheritedPrefixes = ["F5_PROFILE_", "CLAUDE_CODE_", "GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"];
const inheritedKeys = new Set(["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GIT_CONFIG_COUNT"]);
for (const key of Object.keys(process.env)) {
  if (inheritedKeys.has(key) || inheritedPrefixes.some((prefix) => key.startsWith(prefix))) {
    delete process.env[key];
  }
}

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // Tests opt into host settings explicitly. Default production behavior must
      // not make fixtures depend on Windows autocrlf or a developer's gh login.
      env: {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: "0",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GH_CONFIG_DIR: join(tmpdir(), `f5-vitest-gh-${process.pid}`),
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
        GH_ENTERPRISE_TOKEN: "",
        GITHUB_ENTERPRISE_TOKEN: "",
      },
      // Real Git fixtures and SQLite cleanup take longer on Windows/NTFS.
      testTimeout: process.platform === "win32" ? 30_000 : 15_000,
      hookTimeout: process.platform === "win32" ? 30_000 : 15_000,
      maxWorkers: Number.parseInt(
        process.env.F5_TEST_MAX_WORKERS ?? process.env.VITEST_MAX_WORKERS ?? "8",
        10,
      ),
      execArgv: ["--no-warnings"],
      onConsoleLog() {
        return process.env.F5_TEST_LOGS === "1";
      },
    },
  }),
);
