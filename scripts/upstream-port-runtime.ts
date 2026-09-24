import { execFileSync } from "node:child_process";
import path from "node:path";
import { type Ledger } from "./upstream-port-ledger.ts";
import { assertValid, validateProvenance } from "./upstream-port-validation.ts";

export const root = path.resolve(
  process.env.F5_UPSTREAM_PORTS_ROOT ?? path.join(import.meta.dirname, ".."),
);
export const ledgerPath = path.resolve(
  process.env.F5_UPSTREAM_PORTS_LEDGER_PATH ?? path.join(root, "scripts/upstream-ports.json"),
);
export const legacyManifestPath = path.resolve(
  process.env.F5_UPSTREAM_PORTS_MANIFEST_PATH ??
    path.join(root, "scripts/upstream-ports.manifest.json"),
);
export function git(args: ReadonlyArray<string>): string {
  return execFileSync("git", [...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
export function checkLedger(
  ledger: Ledger,
  options: { allowPending?: boolean; requireUpstream?: boolean } = {},
): void {
  assertValid(ledger, root, options.allowPending);
  let hasRemote = false;
  try {
    git(["remote", "get-url", "upstream"]);
    hasRemote = true;
  } catch {
    /* optional offline validation */
  }
  if (hasRemote) validateProvenance(ledger, git);
  else if (options.requireUpstream || process.env.F5_REQUIRE_UPSTREAM === "1")
    throw new Error("the authoritative upstream remote is required but is not configured");
  else
    console.warn(
      "upstream ports: authoritative upstream remote is unavailable; provenance check skipped",
    );
}
