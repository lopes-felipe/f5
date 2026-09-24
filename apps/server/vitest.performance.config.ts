import { defineConfig, mergeConfig } from "vitest/config";
import serverConfig from "./vitest.config.ts";

export default mergeConfig(
  serverConfig,
  defineConfig({
    test: {
      include: ["scripts/performance/server.perf.ts"],
      fileParallelism: false,
      maxWorkers: 1,
      onConsoleLog: () => false,
    },
  }),
);
