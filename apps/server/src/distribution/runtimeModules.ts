// @effect-diagnostics nodeBuiltinImport:off
import * as path from "node:path";
import { createRequire } from "node:module";
/** fff is import-only ESM; a SEA must resolve it from its adjacent real filesystem. */
export function loadFff(): Promise<typeof import("@ff-labs/fff-node")> {
  if (process.env.F5_STANDALONE_DIR) {
    const file = path.join(
      process.env.F5_STANDALONE_DIR,
      "node_modules",
      "@ff-labs/fff-node",
      "dist",
      "src",
      "index.js",
    );
    return Promise.resolve(
      createRequire(process.execPath)(file) as typeof import("@ff-labs/fff-node"),
    );
  }
  const load = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<typeof import("@ff-labs/fff-node")>;
  return load("@ff-labs/fff-node");
}
