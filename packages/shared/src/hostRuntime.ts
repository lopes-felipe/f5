import * as path from "node:path";
/** A SEA executable cannot run --eval or JavaScript helper scripts. */
export function javascriptRuntimeExecutable(): string {
  return process.env.F5_STANDALONE_DIR
    ? path.join(
        process.env.F5_STANDALONE_DIR,
        "runtime",
        process.platform === "win32" ? "node.exe" : "node",
      )
    : process.execPath;
}
