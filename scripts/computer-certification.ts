import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { release } from "node:os";
import { execute } from "./computer-certification/process";
import { access } from "node:fs/promises";
import { coverage, record, type Manifest } from "./computer-certification/model";
import { GROUPS, type Group, type Platform, type Provider } from "./computer-certification/catalog";
import {
  initialize,
  loadManifest,
  loadResults,
  writeExclusive,
  readJson,
} from "./computer-certification/store";
import { suiteIdentity, runSuite } from "./computer-certification/suite";
import { preflight } from "./computer-certification/preflight";
import type { Launches } from "./computer-certification/commands";
import type { Target } from "./computer-certification/identity";
import { prepareFixtures } from "./computer-certification/fixtures";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const accepted = [
    "--output",
    "--platform",
    "--arch",
    "--group",
    "--provider",
    "--app",
    "--helper",
    "--claude-home",
    "--claude-binary",
    "--claude-model",
    "--codex-home",
    "--codex-binary",
    "--codex-model",
    "--retry",
    "--scenario",
  ];
  for (let i = 0; i < args.length; i++) {
    const name = args[i]!;
    if (name === "--operator-ready") {
      if (flags.has(name)) throw new Error("Duplicate argument");
      flags.add(name);
      continue;
    }
    if (
      !accepted.includes(name) ||
      values.has(name) ||
      !args[i + 1] ||
      args[i + 1]!.startsWith("--")
    )
      throw new Error("Invalid suite arguments");
    values.set(name, args[++i]!);
  }
  const directory = values.get("--output");
  if (!directory || !["prepare", "run", "resume", "report"].includes(command ?? ""))
    throw new Error(
      "Usage: bun scripts/computer-certification.ts prepare|run|resume|report --output <suite-directory> [--platform darwin|win32] [--group automated|workflows|protection|recovery|builtin|chrome] [--provider both|claude|codex] [--app <installed-app> | --helper <dev-helper>] [--<provider>-home <selected-home> --<provider>-binary <cli>] [--operator-ready] [--scenario <new-phase> | --retry <failed-phase>]",
    );
  const output = resolve(directory);
  if (command === "report") {
    const manifest = await loadManifest(output);
    process.stdout.write(
      JSON.stringify(coverage(manifest, await loadResults(output, manifest)), null, 2) + "\n",
    );
    return;
  }
  const saved = command === "prepare" ? undefined : await readJson(join(output, "launch.json"));
  if (saved !== undefined && (!record(saved) || !record(saved.target) || !record(saved.launches)))
    throw new Error("Invalid launch configuration");
  const stored = saved as
    | {
        target?: { platform?: Platform; arch?: "arm64" | "x64"; app?: string; helper?: string };
        launches?: Launches;
      }
    | undefined;
  const platform = values.get("--platform") ?? stored?.target?.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "win32") throw new Error("Choose darwin or win32");
  const previousManifest = command === "prepare" ? undefined : await loadManifest(output);
  const provider =
    values.get("--provider") ??
    (previousManifest?.providers.length === 1 ? previousManifest.providers[0] : "both") ??
    "both";
  if (!["both", "claude", "codex"].includes(provider)) throw new Error("Invalid provider");
  const providers: Provider[] = provider === "both" ? ["codex", "claude"] : [provider as Provider];
  const launches: Launches = {};
  for (const name of providers) {
    const home = values.get("--" + name + "-home") ?? stored?.launches?.[name]?.home;
    const binary = values.get("--" + name + "-binary") ?? stored?.launches?.[name]?.binary;
    if (
      (home !== undefined && typeof home !== "string") ||
      (binary !== undefined && typeof binary !== "string")
    )
      throw new Error("Invalid launch configuration");
    if (!!home !== !!binary) throw new Error("Provider home and binary must be specified together");
    const model = values.get("--" + name + "-model") ?? stored?.launches?.[name]?.model;
    if (model !== undefined && typeof model !== "string")
      throw new Error("Invalid launch configuration");
    if (home && binary)
      launches[name] = {
        home: resolve(home),
        binary: resolve(binary),
        ...(model ? { model } : {}),
      };
  }
  const app = values.get("--app") ?? stored?.target?.app,
    helper = values.get("--helper") ?? stored?.target?.helper;
  if (
    (app !== undefined && typeof app !== "string") ||
    (helper !== undefined && typeof helper !== "string")
  )
    throw new Error("Invalid launch configuration");
  const arch =
    values.get("--arch") ??
    stored?.target?.arch ??
    (process.platform === platform ? process.arch : "x64");
  if (arch !== "arm64" && arch !== "x64") throw new Error("Invalid architecture");
  const target: Target = {
    repo: resolve(import.meta.dirname, ".."),
    platform: platform as Platform,
    arch,
    ...(app ? { app: resolve(app) } : {}),
    ...(helper ? { helper: resolve(helper) } : {}),
    fixtureDirectory: join(output, "fixtures"),
  };
  if (command === "prepare") {
    let alreadyPrepared = false;
    try {
      await access(join(output, "manifest.json"));
      alreadyPrepared = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (alreadyPrepared) throw new Error("Suite already prepared; choose a new directory");
    if (!target.app && process.platform === platform) {
      const build = await execute(
        { executable: "bun", args: ["run", "build:desktop"], timeoutMs: 300000 },
        target.repo,
      );
      if (build.code !== 0 || build.interrupted || build.timedOut)
        throw new Error("Development artifacts failed to build; no machine check can start");
    }
    const fixturesReady = await prepareFixtures(target, target.fixtureDirectory!);
    const identity = await suiteIdentity(target, launches);
    const observed = await preflight(target, launches);
    const manifest: Manifest = {
      version: 1,
      suiteId: randomUUID(),
      preparedAt: new Date().toISOString(),
      identity,
      providers,
      prerequisites: { ...observed.checks, "fixtures-ready": fixturesReady },
      observations: {
        osVersion: platform === process.platform ? release() : "unavailable",
        providerVersions: observed.providerVersions,
        displays: observed.displays,
      },
    };
    await initialize(output, manifest);
    // Local launch configuration is private and excluded from all coverage output.
    await writeExclusive(join(output, "launch.json"), { target, launches });
    process.stdout.write(
      "Suite prepared at " + output + ". No capture, grant, permit or input was sent.\n",
    );
    return;
  }
  const group = values.get("--group");
  if (!group || !GROUPS.includes(group as Group)) throw new Error("Choose a certification group");
  const retry = values.get("--retry");
  const scenario = values.get("--scenario");
  const summary = await runSuite({
    directory: output,
    target,
    launches,
    group: group as Group,
    resume: command === "resume",
    operatorReady: flags.has("--operator-ready"),
    ...(scenario ? { scenario } : {}),
    ...(retry ? { retry } : {}),
  });
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  const selectedScenario = scenario ?? retry;
  if (
    summary.rows.some(
      (row) =>
        row.group === group &&
        (!selectedScenario || row.scenario === selectedScenario) &&
        row.state !== "passed",
    )
  )
    process.exitCode = 1;
}
if (import.meta.main)
  await main().catch((error: unknown) => {
    // Only our fixed messages; subprocess output, account data and raw errors are excluded.
    process.stderr.write(
      error instanceof Error &&
        /^(Usage:|Choose |Invalid |Unknown |Operator |Artifact\/source |Suite runner |Previous runner |Retry |Interrupted admission|Provider home|Duplicate argument|Installed target)/.test(
          error.message,
        )
        ? error.message + "\n"
        : "Certification command failed; no release gate changed.\n",
    );
    process.exitCode = 1;
  });
