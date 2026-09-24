import { defineConfig, mergeConfig } from "vitest/config";
import serverConfig from "./vitest.config.ts";

export default mergeConfig(
  serverConfig,
  defineConfig({
    test: {
      include: [
        process.env.F5_PERF_INTERACTIVE === "1"
          ? "scripts/performance/interactive.perf.ts"
          : "scripts/performance/server.perf.ts",
      ],
      pool: "forks",
      execArgv: ["--expose-gc", "--no-warnings"],
      fileParallelism: false,
      maxWorkers: 1,
      onConsoleLog: () => false,
    },
  }),
);
