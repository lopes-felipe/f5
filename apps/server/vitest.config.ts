import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
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
