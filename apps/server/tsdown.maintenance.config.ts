import { defineConfig } from "tsdown";

// An independent bundle keeps synchronous maintenance and provider SDK loading
// isolated from each other in ESM, CJS and Electron's Node child runtime.
export default defineConfig({
  entry: { "backup-maintenance": "src/backupMaintenanceEntry.ts" },
  format: ["esm", "cjs"],
  checks: { legacyCjs: false },
  outDir: "dist/maintenance",
  clean: true,
  external: ["bun:sqlite"],
  noExternal: (id) => !id.startsWith("node:") && id !== "bun:sqlite",
  inlineOnly: false,
  outputOptions: { inlineDynamicImports: true },
});
