import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const mswDirectory = fileURLToPath(new URL("../apps/web/node_modules/msw", import.meta.url));
const checkedInWorker = readFileSync(
  new URL("../apps/web/public/mockServiceWorker.js", import.meta.url),
  "utf8",
);
const vendorWorker = readFileSync(join(mswDirectory, "lib/mockServiceWorker.js"), "utf8");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function postinstall(manifest: unknown, initialWorker: string) {
  const directory = mkdtempSync(join(tmpdir(), "f5-msw-install-"));
  directories.push(directory);
  mkdirSync(join(directory, "public"));
  const worker = join(directory, "public/mockServiceWorker.js");
  writeFileSync(worker, initialWorker);
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  const result = spawnSync(
    process.execPath,
    [join(mswDirectory, "config/scripts/postinstall.js")],
    {
      cwd: mswDirectory,
      env: { ...process.env, INIT_CWD: directory },
      encoding: "utf8",
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return readFileSync(worker, "utf8");
}

describe("MSW worker installation", () => {
  it("copies vendor bytes even when only formatting differs at the same version", () => {
    const formattedWorker = checkedInWorker + "\n";
    expect(postinstall({ msw: { workerDirectory: ["public"] } }, formattedWorker)).toBe(
      vendorWorker,
    );
    expect(formattedWorker).not.toBe(vendorWorker);
  });
  it("preserves the checked-in worker with the repository install policy", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(postinstall(manifest, checkedInWorker)).toBe(checkedInWorker);
  });
  it("requires explicit regeneration when the installed MSW version changes", () => {
    const installed = JSON.parse(readFileSync(join(mswDirectory, "package.json"), "utf8")) as {
      version: string;
    };
    expect(checkedInWorker.match(/PACKAGE_VERSION = ["']([^"']+)/)?.[1]).toBe(installed.version);
  });
});
