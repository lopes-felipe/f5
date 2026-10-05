#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import { parseRelease, CLI_TARGETS, type CliRelease } from "@t3tools/shared/cliRelease";
export function mergeCliManifests(manifests: readonly CliRelease[]): CliRelease {
  const first = manifests[0];
  if (!first || manifests.some((manifest) => manifest.version !== first.version))
    throw new Error("Manifest versions must match.");
  const release = parseRelease({
    schemaVersion: 1,
    version: first.version,
    artifacts: manifests.flatMap((manifest) => manifest.artifacts),
  });
  if (
    CLI_TARGETS.some((target) => !release.artifacts.some((artifact) => artifact.target === target))
  )
    throw new Error("A release manifest requires all five supported CLI targets.");
  return release;
}
if (process.argv[1]?.endsWith("merge-cli-release-manifests.ts")) {
  const [output, ...inputs] = process.argv.slice(2);
  if (!output || !inputs.length)
    throw new Error("Usage: merge-cli-release-manifests.ts OUTPUT INPUT...");
  const manifests = await Promise.all(
    inputs.map(async (input) => parseRelease(JSON.parse(await fs.readFile(input, "utf8")))),
  );
  await fs.writeFile(output, JSON.stringify(mergeCliManifests(manifests), null, 2) + "\n", {
    flag: "wx",
  });
}
