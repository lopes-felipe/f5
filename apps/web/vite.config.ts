import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vitest/config";

import { ciTestReports } from "../../scripts/lib/ci-test-reports";
import pkg from "./package.json" with { type: "json" };

const port = Number(process.env.PORT ?? 5733);
const sourcemapEnv = process.env.T3CODE_WEB_SOURCEMAP?.trim().toLowerCase();

const buildSourcemap =
  sourcemapEnv === "1" || sourcemapEnv === "true"
    ? true
    : sourcemapEnv === "hidden"
      ? "hidden"
      : false;

export default defineConfig({
  test: ciTestReports(),
  plugins: [
    tanstackRouter({
      // Route components are the largest independent UI surfaces in F5.
      // Keep route metadata synchronous while loading settings, PR Hub,
      // workflows, and thread detail only when navigation requires them.
      autoCodeSplitting: true,
    }),
    react(),
    // React Compiler, staged: annotation mode compiles only modules and
    // components that opt in with a "use memo" directive (timeline rows,
    // sidebar, Home, palette results, chat header). Switching to "infer"
    // comes after a release without regressions.
    babel({ presets: [reactCompilerPreset({ compilationMode: "annotation" })] }),
    tailwindcss(),
  ],
  optimizeDeps: {
    include: [
      "@pierre/diffs",
      "@pierre/diffs/react",
      "@pierre/diffs/worker/worker.js",
      "react-dom/client",
      "effect/Encoding",
      "effect/Result",
      // Imported only by the code highlight worker, so the dev server would
      // otherwise discover them late and reload the page.
      "shiki/core",
      "shiki/engine/javascript",
    ],
  },
  define: {
    // In dev mode, tell the web app where the WebSocket server lives
    "import.meta.env.VITE_WS_URL": JSON.stringify(process.env.VITE_WS_URL ?? ""),
    "import.meta.env.APP_VERSION": JSON.stringify(pkg.version),
  },
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port,
    strictPort: true,
    hmr: {
      // Explicit config so Vite's HMR WebSocket connects reliably
      // inside Electron's BrowserWindow. Vite 8 uses console.debug for
      // connection logs — enable "Verbose" in DevTools to see them.
      protocol: "ws",
      host: "localhost",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: buildSourcemap,
  },
});
