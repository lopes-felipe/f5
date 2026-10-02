import { nativePreflight } from "./nativePreflight";
// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { version } from "../../package.json" with { type: "json" };
import { cliTarget, RELEASE_MANIFEST_URL } from "@t3tools/shared/cliRelease";
import {
  acquireInstallLock,
  fetchRelease,
  stageRelease,
  readInstalled,
  runtimePaths,
  discoverNode,
} from "./installation";
import { atomicJson, exists, readJson } from "./files";
import { requestUpdate } from "./handoff";
import { manageService } from "./services";
const exec = promisify(execFile);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export async function installLauncher(root: string, selectedVersion: string): Promise<void> {
  const runtime = runtimePaths(root, selectedVersion);
  const destination = path.join(root, "launcher-v1");
  if (!(await exists(destination))) {
    const staging = path.join(root, `.launcher-${process.pid}`);
    await fs.mkdir(staging, { mode: 0o700 });
    try {
      const node = await discoverNode([runtime.node, process.env.F5_NODE_PATH ?? "node"]);
      await fs.copyFile(
        node,
        path.join(staging, process.platform === "win32" ? "node.exe" : "node"),
      );
      await fs.copyFile(
        path.join(runtime.directory, "runtime", "LICENSE"),
        path.join(staging, "LICENSE"),
      );
      await fs.copyFile(
        path.join(runtime.directory, "launcher.cjs"),
        path.join(staging, "launcher.cjs"),
      );
      await fs.rename(staging, destination);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
  const node = path.join(destination, process.platform === "win32" ? "node.exe" : "node");
  const launcher = path.join(destination, "launcher.cjs");
  const preflight = await exec(node, [launcher, "--preflight"], {
    timeout: 10_000,
    maxBuffer: 4096,
  });
  const info: unknown = JSON.parse(preflight.stdout);
  if (
    !info ||
    typeof info !== "object" ||
    !("launcherProtocol" in info) ||
    info.launcherProtocol !== 1 ||
    !("target" in info) ||
    info.target !== cliTarget()
  )
    throw new Error("Installed launcher is incompatible.");
  const bin = path.join(root, "bin");
  await fs.mkdir(bin, { recursive: true });
  // The entry resolves the current immutable version on each invocation; no PATH Node is needed.
  const entry = `const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');\nconst root=${JSON.stringify(root)};\nconst current=JSON.parse(fs.readFileSync(path.join(root,'current.json'),'utf8'));\nif(!/^\\d+\\.\\d+\\.\\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(current.version))throw Error('Invalid installation');\nconst child=cp.spawn(path.join(root,'versions',current.version,process.platform==='win32'?'f5.exe':'f5'),process.argv.slice(2),{stdio:'inherit',env:{...process.env,F5_INSTALL_ROOT:root}});\nfor(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));\nchild.on('error',()=>{process.exitCode=1});child.on('exit',(code)=>{process.exitCode=code??1});\n`;
  await fs.writeFile(path.join(bin, "entry.cjs"), entry, { mode: 0o600 });
  if (process.platform === "win32") {
    if (root.includes('"') || /[\r\n%]/.test(root))
      throw new Error("Unsupported Windows install path.");
    await fs.writeFile(
      path.join(bin, "f5.cmd"),
      `@echo off\r\n"${node}" "${path.join(bin, "entry.cjs")}" %*\r\n`,
    );
  } else
    await fs.writeFile(
      path.join(bin, "f5"),
      `#!/bin/sh\nexec ${quote(node)} ${quote(path.join(bin, "entry.cjs"))} "$@"\n`,
      { mode: 0o755 },
    );
}
export async function runDistributionCommand(args: readonly string[]): Promise<boolean> {
  const command = args[0];
  if (
    !["install", "update", "update-status", "service", "serve", "runtime-preflight"].includes(
      command ?? "",
    )
  )
    return false;
  if (command === "runtime-preflight") {
    // Exercise the native modules, not just their presence in the archive.
    await nativePreflight();
    console.log(JSON.stringify({ version, target: cliTarget(), launcherProtocol: 1 }));
    return true;
  }
  const options = args.slice(1);
  if (options.includes("--help")) {
    console.log(
      "F5 standalone: install|update [--manifest HTTPS_URL] [--install-dir PATH]; serve [--state-dir PATH] [server flags]; update-status; service install|start|stop|restart|status|uninstall [--state-dir PATH]. Source and existing no-subcommand server invocation remain supported.",
    );
    return true;
  }
  if (
    command === "serve" &&
    options.some((option) => option === "--profile" || option.startsWith("--profile="))
  )
    throw new Error(
      "A launcher owns the default profile of --state-dir. Use a separate install/state directory for another service profile.",
    );
  if (command !== "serve") {
    const allowed =
      command === "install" || command === "update"
        ? ["--install-dir", "--manifest"]
        : ["--install-dir", "--state-dir"];
    for (let index = command === "service" ? 1 : 0; index < options.length; index += 2) {
      if (!allowed.includes(options[index]!))
        throw new Error(`Unknown ${command} option: ${options[index]}`);
      if (!options[index + 1] || options[index + 1]!.startsWith("--"))
        throw new Error(`Missing value for ${options[index]}`);
    }
  }
  const readOption = (name: string, fallback: string) => {
    const index = options.indexOf(name);
    if (index < 0) return fallback;
    const value = options[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing ${name}.`);
    return value;
  };
  const root = path.resolve(
    readOption(
      "--install-dir",
      process.env.F5_INSTALL_ROOT ?? path.join(os.homedir(), ".f5", "cli"),
    ),
  );
  const stateDir = path.resolve(
    readOption(
      "--state-dir",
      process.env.F5_STATE_DIR ?? path.join(os.homedir(), ".f5", "cli-state"),
    ),
  );
  if (command === "install" || command === "update") {
    if (command === "install" && (await exists(path.join(root, "current.json"))))
      throw new Error("F5 is already installed. Use f5 update.");
    if (command === "update") {
      await readInstalled(root);
      if (!(await exists(path.join(root, "launcher.json"))))
        throw new Error(
          "Start f5 serve or its service before updating, so the launcher can safely stop and recover the profile database.",
        );
    }
    const releaseLock = await acquireInstallLock(root);
    try {
      const release = await fetchRelease(readOption("--manifest", RELEASE_MANIFEST_URL));
      const selected = await stageRelease(root, release, (message) => console.log(message));
      await installLauncher(root, selected);
      if (command === "install") {
        await atomicJson(path.join(root, "current.json"), {
          schemaVersion: 1,
          version: selected,
          target: cliTarget(),
        });
        console.log(
          `Installed F5 ${selected}. Add ${path.join(root, "bin")} to PATH, then run f5 serve.`,
        );
      } else {
        const request = await requestUpdate(root, selected);
        console.log(
          `Update ${request.id} staged. Use f5 update-status to check its correlated outcome.`,
        );
      }
    } finally {
      await releaseLock();
    }
    return true;
  }
  if (command === "update-status") {
    for (const file of ["pending.json", "handoff.json", "outcome.json"])
      if (await exists(path.join(root, file)))
        console.log(`${file}: ${JSON.stringify(await readJson(path.join(root, file)))}`);
    return true;
  }
  if (command === "service") {
    const action = options[0];
    if (!["install", "start", "stop", "restart", "status", "uninstall"].includes(action ?? ""))
      throw new Error(
        "Usage: f5 service install|start|stop|restart|status|uninstall [--state-dir PATH]",
      );
    await readInstalled(root);
    await manageService(action!, root, stateDir);
    return true;
  }
  // Serve uses the stable built-in-only launcher; current no-subcommand invocation still works.
  const remaining: string[] = [];
  for (let index = 0; index < options.length; index++) {
    if (options[index] === "--install-dir" || options[index] === "--state-dir") {
      index++;
      continue;
    }
    remaining.push(options[index]!);
  }
  const { runLauncher } = await import("./launcher");
  await runLauncher(root, stateDir, remaining);
  return true;
}
