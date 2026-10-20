import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeCiProcessDiagnostics } from "./lib/ci-process-diagnostics.ts";

/** Bun 1.3.9 emits a package-to-advisory-array map, including severities below the exit threshold. */
export function validateDependencyAudit(stdout: string, status: number | null): number {
  const report: unknown = JSON.parse(stdout);
  if (!report || typeof report !== "object" || Array.isArray(report))
    throw new Error("Malformed dependency audit JSON");
  let blocking = 0;
  for (const [name, entries] of Object.entries(report)) {
    if (!name || !Array.isArray(entries) || entries.length === 0)
      throw new Error("Malformed dependency advisory list");
    for (const advisory of entries) {
      if (
        !advisory ||
        typeof advisory !== "object" ||
        !Number.isSafeInteger(advisory.id) ||
        typeof advisory.title !== "string" ||
        typeof advisory.url !== "string" ||
        typeof advisory.vulnerable_versions !== "string" ||
        !["info", "low", "moderate", "high", "critical"].includes(advisory.severity)
      )
        throw new Error("Malformed dependency advisory");
      if (advisory.severity === "high" || advisory.severity === "critical") blocking++;
    }
  }
  if (blocking)
    throw new Error(`Dependency audit found ${blocking} high/critical advisory entries`);
  if (status !== 0)
    throw new Error(`Dependency audit scanner failed (${status ?? "no exit status"})`);
  return Object.values(report).reduce(
    (count: number, entries) => count + (entries as unknown[]).length,
    0,
  );
}

function main() {
  const result = spawnSync("bun", ["audit", "--json", "--audit-level=high"], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  let failure: unknown;
  try {
    if (result.error) throw result.error;
    const count = validateDependencyAudit(result.stdout, result.status);
    console.log(
      `Dependency audit passed the high threshold (${count} lower-severity advisory entries).`,
    );
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // Bounded, sanitized scanner text; never put raw output into the status issue.
    writeCiProcessDiagnostics("dependency-audit", result.stdout + "\n" + result.stderr, failure);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
