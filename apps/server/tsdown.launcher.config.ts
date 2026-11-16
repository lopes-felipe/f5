import { defineConfig } from "tsdown";

// The stable CLI supervisor is a CommonJS script launched by the bundled Node.
// tsdown fails on warnings in CI, so the CommonJS recommendation must be disabled
// here rather than left to fail release builds. The archive builder sets --out-dir.
export default defineConfig({
  entry: ["src/distribution/launcherEntry.ts"],
  format: ["cjs"],
  checks: { legacyCjs: false },
});
