import * as path from "node:path";
import { defineConfig } from "vitest/config";

import { ciTestReports } from "./scripts/lib/ci-test-reports";
import { isolateTestHome } from "./scripts/lib/test-home";

// Every package config merges this file; root the whole run in a throwaway home.
isolateTestHome();

export default defineConfig({
  test: ciTestReports(),
  resolve: {
    alias: [
      {
        find: /^@t3tools\/contracts$/,
        replacement: path.resolve(import.meta.dirname, "./packages/contracts/src/index.ts"),
      },
    ],
  },
});
