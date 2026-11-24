// @effect-diagnostics nodeBuiltinImport:off
import { appendFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ATTEMPT = /^vm-backend-manifest-attempt-([1-9]\d*)$/;

/**
 * The linux-arm64 manifest the macOS arm64 desktop pins: the one from the latest cli attempt
 * at or before this run attempt. The candidate publishes the archive of the latest attempt
 * that has a receipt, and release-cli.yml uploads each attempt's manifest before its
 * receipt, so the two name the same archive.
 *
 * `dir` holds the downloaded `vm-backend-manifest-attempt-N` artifacts, one directory each.
 */
export function selectVmBackendManifest(dir: string, runAttempt: number, version: string): string {
  const attempts = readdirSync(dir)
    .map((name) => Number(ATTEMPT.exec(name)?.[1]))
    .filter((attempt) => attempt > 0 && attempt <= runAttempt);
  if (attempts.length === 0)
    throw new Error(`No Linux VM backend manifest artifact at or before attempt ${runAttempt}`);
  const manifest = join(
    dir,
    `vm-backend-manifest-attempt-${Math.max(...attempts)}`,
    `f5-${version}-linux-arm64.json`,
  );
  if (!statSync(manifest, { throwIfNoEntry: false })?.size)
    throw new Error(`The Linux VM backend manifest is missing or empty: ${manifest}`);
  return resolve(manifest);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [dir, version] = process.argv.slice(2);
  if (!dir || !version) throw new Error("Usage: select-vm-backend-manifest DIR VERSION");
  const manifest = selectVmBackendManifest(dir, Number(process.env.GITHUB_RUN_ATTEMPT), version);
  appendFileSync(process.env.GITHUB_ENV!, `F5_VM_BACKEND_MANIFEST=${manifest}\n`);
  console.log(manifest);
}
