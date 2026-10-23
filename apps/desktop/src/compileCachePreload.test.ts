import * as Path from "node:path";
import { expect, it } from "vitest";

import { compileCachePreloadArgs } from "./compileCachePreload";

it("preloads the compile cache only when the packaged file exists", () => {
  const directory = Path.join("/app.asar", "apps", "desktop", "dist-electron");
  const preload = Path.join(directory, "compileCache.js");
  expect(compileCachePreloadArgs(directory, (path) => path === preload)).toEqual([
    "--require",
    preload,
  ]);
  // A missing preload would make Node exit before the server starts.
  expect(compileCachePreloadArgs(directory, () => false)).toEqual([]);
});
