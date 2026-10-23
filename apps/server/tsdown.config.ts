import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  checks: {
    legacyCjs: false,
  },
  outDir: "dist",
  sourcemap: true,
  clean: true,
  external: ["bun:sqlite"],
  // These entries expose only the import condition. Bundle them so CommonJS
  // never generates an unsupported require of an import-only package entry.
  noExternal: (id) =>
    id.startsWith("@t3tools/") || id === "@opencode-ai/sdk/v2" || id === "@pierre/diffs",
  inlineOnly: false,
  // Keep generated helpers out of the server entry's import cycle. Shared chunks
  // can execute before that entry initializes its own top-level variables.
  outputOptions: {
    codeSplitting: {
      groups: [{ name: "runtime-helpers", test: (id) => id === "\0rolldown/runtime.js" }],
    },
  },
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});
