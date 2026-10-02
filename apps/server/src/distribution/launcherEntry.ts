// @effect-diagnostics nodeBuiltinImport:off
import * as path from "node:path";
import { runLauncher } from "./launcher";
import { cliTarget } from "@t3tools/shared/cliRelease";
const args = process.argv.slice(2);
if (args[0] === "--preflight")
  console.log(JSON.stringify({ launcherProtocol: 1, target: cliTarget() }));
else {
  const root = args[0];
  const stateDir = args[1];
  if (!root || !stateDir || !path.isAbsolute(root) || !path.isAbsolute(stateDir))
    throw new Error("Launcher requires absolute install root and profile state directory.");
  void runLauncher(root, stateDir, args.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "F5 launcher failed.");
    process.exitCode = 1;
  });
}
