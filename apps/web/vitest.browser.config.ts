import { resolve } from "node:path";
import { ciTestReports } from "../../scripts/lib/ci-test-reports";
import { assetSecurityFixture } from "./test/assetSecurityFixture";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));

const browserConfig = mergeConfig(
  viteConfig,
  defineConfig({
    plugins: [assetSecurityFixture()],
    resolve: {
      alias: {
        "~": srcPath,
      },
    },
    server: {
      // Loading Babel and the React Compiler on the first transformed web module
      // takes about half a second; warm up a representative component at startup
      // instead of paying that cost inside whichever browser test runs first.
      warmup: { clientFiles: ["./src/components/Sidebar.tsx"] },
    },
    test: {
      include: ["src/**/*.browser.{ts,tsx}"],
      browser: {
        // Separate worktrees and concurrent test runs must not contend for a fixed port.
        api: { strictPort: false },
        enabled: true,
        screenshotDirectory: resolve(
          process.env.F5_CI_ARTIFACT_DIR || "./.playwright",
          "screenshots",
        ),
        // Composer tests assert CSS transitions; don't inherit a host reduce setting.
        provider: playwright({ contextOptions: { reducedMotion: "no-preference" } }),
        instances: [{ browser: "chromium" }],
        headless: true,
      },
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  }),
);

// Vite merges reporter arrays; replace them here to avoid writing each report twice.
export default { ...browserConfig, test: { ...browserConfig.test, ...ciTestReports() } };
