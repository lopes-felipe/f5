import * as FS from "node:fs";
import * as Path from "node:path";

/**
 * Node arguments that preload the compile cache into the packaged backend. Node exits before the
 * server starts when a `--require` target is missing, so a packaging change that drops the file
 * costs the cache, not the backend.
 */
export function compileCachePreloadArgs(
  directory: string,
  exists: (path: string) => boolean = FS.existsSync,
): ReadonlyArray<string> {
  const preload = Path.join(directory, "compileCache.js");
  return exists(preload) ? ["--require", preload] : [];
}
