import * as path from "node:path";
import { defineConfig } from "tsdown";
import { isRuntimeExternalCliDependency } from "../../scripts/lib/cli-external-packages.ts";
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
    js: 'require = require("node:module").createRequire(process.execPath); process.env.F5_STANDALONE = "1";',
  },
});
