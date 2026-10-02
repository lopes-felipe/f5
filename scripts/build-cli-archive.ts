#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// Standalone packaging uses only build-host tools; none are required after installation.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import serverPackage from "../apps/server/package.json" with { type: "json" };
import { selectCliRuntimeExternalDependencies } from "./lib/cli-external-packages.ts";
import { cliTarget, sha256File, versionToken, type CliRelease } from "@t3tools/shared/cliRelease";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI_NODE_VERSION = "26.10.0";
export async function buildCliArchive(options: {
  target: string;
  output: string;
  node: string;
  skipBuild?: boolean;
}): Promise<CliRelease> {
  const target = cliTarget();
  if (options.target !== target)
    throw new Error(
      "Native CLI archives must be built on a runner with the matching platform and architecture.",
    );
  const version = versionToken(serverPackage.version);
  const node = path.resolve(options.node);
  const runtime = JSON.parse(
    execFileSync(
      node,
      [
        "-p",
        "JSON.stringify({version:process.versions.node,target:process.platform+'-'+process.arch})",
      ],
      { encoding: "utf8" },
    ),
  ) as { version: string; target: string };
  if (runtime.version !== CLI_NODE_VERSION || runtime.target !== target)
    throw new Error(`Build requires Node ${CLI_NODE_VERSION} for ${target}.`);
  const run = (command: string, args: string[], cwd = repo) => {
    const result = spawnSync(command, args, {
      cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      shell: process.platform === "win32" && command === "bun",
    });
    if (result.error || result.status !== 0) throw new Error(`Build command failed: ${command}.`);
  };
  if (!options.skipBuild) {
    run("bun", ["run", "--cwd", "apps/web", "build"]);
    run("bun", ["run", "--cwd", "apps/server", "build"]);
  }
  run(
    node,
    [
      path.join(repo, "apps/server/node_modules/tsdown/dist/run.mjs"),
      "--config",
      "tsdown.standalone.config.ts",
    ],
    path.join(repo, "apps/server"),
  );
  const output = path.resolve(options.output);
  await fs.mkdir(output, { recursive: true });
  const stem = `f5-${version}-${target}`;
  const temporary = await fs.mkdtemp(path.join(output, ".cli-stage-"));
  const stage = path.join(temporary, stem);
  await fs.mkdir(stage);
  try {
    const executable = path.join(stage, process.platform === "win32" ? "f5.exe" : "f5");
    const runtimeNode = path.join(temporary, process.platform === "win32" ? "node.exe" : "node");
    if (process.platform === "darwin") {
      const architectures = execFileSync("lipo", ["-archs", node], { encoding: "utf8" })
        .trim()
        .split(/\s+/);
      if (architectures.length > 1)
        run("lipo", [node, "-thin", process.arch, "-output", runtimeNode]);
      else await fs.copyFile(node, runtimeNode);
      run("codesign", ["--force", "--sign", "-", runtimeNode]);
    } else await fs.copyFile(node, runtimeNode);
    const seaConfig = path.join(temporary, "sea.json");
    await fs.writeFile(
      seaConfig,
      JSON.stringify({
        main: path.join(repo, "apps/server/dist-exe/index.cjs"),
        output: executable,
        executable: runtimeNode,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
      }),
    );
    run(node, ["--build-sea", seaConfig]);
    if (process.platform === "darwin") run("codesign", ["--force", "--sign", "-", executable]);
    if (process.platform !== "win32") await fs.chmod(executable, 0o755);
    await fs.cp(path.join(repo, "apps/server/dist/client"), path.join(stage, "client"), {
      recursive: true,
    });
    await fs.mkdir(path.join(stage, "runtime"));
    await fs.copyFile(
      path.join(repo, "scripts/assets/node/LICENSE-26.10.0.txt"),
      path.join(stage, "runtime", "LICENSE"),
    );
    await fs.copyFile(
      runtimeNode,
      path.join(stage, "runtime", process.platform === "win32" ? "node.exe" : "node"),
    );
    // A stable supervisor bundles built-ins only and survives changes to the server bundle.
    run(
      node,
      [
        path.join(repo, "apps/server/node_modules/tsdown/dist/run.mjs"),
        "src/distribution/launcherEntry.ts",
        "--format",
        "cjs",
        "--out-dir",
        path.join(temporary, "launcher"),
        "--no-config",
      ],
      path.join(repo, "apps/server"),
    );
    await fs.copyFile(
      path.join(temporary, "launcher/launcherEntry.cjs"),
      path.join(stage, "launcher.cjs"),
    );
    const dependencies = selectCliRuntimeExternalDependencies(serverPackage.dependencies);
    // fff's optional platform binary is explicit, so installer settings cannot silently omit it.
    const fffPlatform = target.startsWith("linux-") ? `${target}-gnu` : target;
    dependencies[`@ff-labs/fff-bin-${fffPlatform}`] =
      serverPackage.dependencies["@ff-labs/fff-node"];
    await fs.writeFile(
      path.join(stage, "package.json"),
      JSON.stringify({
        name: "f5-cli-runtime",
        version,
        private: true,
        dependencies,
        trustedDependencies: ["node-pty"],
      }),
    );
    await fs.writeFile(
      path.join(stage, "runtime.json"),
      JSON.stringify({
        schemaVersion: 1,
        version,
        target,
        nodeVersion: CLI_NODE_VERSION,
        launcherProtocol: 1,
      }),
    );
    run("bun", ["install", "--production", "--linker", "hoisted"], stage);
    if (process.platform !== "win32") {
      for (const helper of [
        "build/Release/spawn-helper",
        "build/Debug/spawn-helper",
        `prebuilds/${target}/spawn-helper`,
      ]) {
        const file = path.join(stage, "node_modules/node-pty", helper);
        try {
          await fs.chmod(file, 0o755);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    run(executable, ["runtime-preflight"], stage);
    await fs.rm(path.join(stage, "node_modules/.bin"), { recursive: true, force: true });
    const archive = path.join(output, `${stem}.tar.gz`);
    // Dereference build-store links. Runtime extraction permits regular files/directories only.
    run("tar", ["-czhf", archive, "-C", temporary, stem]);
    const size = (await fs.stat(archive)).size;
    const manifest: CliRelease = {
      schemaVersion: 1,
      version,
      artifacts: [
        {
          target,
          url: `https://github.com/lopes-felipe/f5/releases/download/v${version}/${stem}.tar.gz`,
          sha256: await sha256File(archive),
          size,
        },
      ],
    };
    await fs.writeFile(path.join(output, `${stem}.json`), JSON.stringify(manifest, null, 2) + "\n");
    console.log(`Built ${archive}`);
    return manifest;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name: string, fallback: string) => {
    const index = args.indexOf(name);
    return index < 0 ? fallback : (args[index + 1] ?? fallback);
  };
  await buildCliArchive({
    target: option("--target", cliTarget()),
    output: option("--output", path.join(repo, "release-cli")),
    node: option("--node", process.execPath),
    skipBuild: args.includes("--skip-build"),
  });
}
