import * as path from "node:path";
import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";
import { isRuntimeExternalCliDependency } from "../../scripts/lib/cli-external-packages.ts";

// Inline bundling hoists external provider requires ahead of index.ts's mode
// check. Embed the independently built maintenance entry behind an outer guard
// so a SEA helper never initializes providers or depends on their installations.
// The archive builder builds the server (including this entry) before this config.
const maintenance = readFileSync(
  path.join(import.meta.dirname, "dist/maintenance/backup-maintenance.cjs"),
  "utf8",
);
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  outDir: "dist-exe",
  clean: true,
  checks: { legacyCjs: false },
  inlineOnly: false,
  alias: {
    "@effect/sql-sqlite-bun/SqliteClient": path.join(
      import.meta.dirname,
      "src/persistence/NodeSqliteClient.ts",
    ),
  },
  outputOptions: { inlineDynamicImports: true },
  external: (id) => id === "bun:sqlite" || isRuntimeExternalCliDependency(id),
  noExternal: (id) =>
    !id.startsWith("node:") && id !== "bun:sqlite" && !isRuntimeExternalCliDependency(id),
  banner: {
    js: `require = require("node:module").createRequire(process.execPath);
process.env.F5_STANDALONE = "1";
if (process.argv.includes("--internal-backup-export")) {
  new Function("require", "module", "exports", "__filename", "__dirname", ${JSON.stringify(maintenance)})(require, module, exports, process.execPath, require("node:path").dirname(process.execPath));
} else {`,
  },
  footer: { js: "}" },
});
