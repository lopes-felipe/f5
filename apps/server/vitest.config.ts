import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // Tests opt into host settings explicitly. Default production behavior must
      // not make fixtures depend on Windows autocrlf or a developer's gh login.
      env: {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GH_CONFIG_DIR: join(tmpdir(), `f5-vitest-gh-${process.pid}`),
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
        GH_ENTERPRISE_TOKEN: "",
        GITHUB_ENTERPRISE_TOKEN: "",
      },
      testTimeout: 15_000,
      hookTimeout: 15_000,
      maxWorkers: Number.parseInt(process.env.F5_TEST_MAX_WORKERS ?? "8", 10),
      execArgv: ["--no-warnings"],
      onConsoleLog() {
        return process.env.F5_TEST_LOGS === "1";
      },
    },
  }),
);
