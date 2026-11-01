// @effect-diagnostics nodeBuiltinImport:off
import { mkdirSync, readdirSync, lstatSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { hashFile } from "./release/release-github.ts";
import type { ComponentReceipt } from "./release/release-candidate.ts";
const [directory, component] = process.argv.slice(2);
if (!directory || !/^(desktop|cli)-[a-z0-9-]+$/.test(component ?? ""))
  throw new Error("Usage: record-release-component DIR COMPONENT");
const files: Array<{ name: string; size: number; sha256: string }> = [];
for (const name of readdirSync(directory).sort()) {
  if (name.endsWith(".lock") || name.startsWith("builder-")) continue;
  const file = join(directory, name);
  if (!lstatSync(file).isFile()) throw new Error("Non-regular release component file");
  files.push({ name, size: lstatSync(file).size, sha256: await hashFile(file) });
}
const receipt: ComponentReceipt = {
  ...(component!.startsWith("cli-")
    ? { cliUpgradeBaseline: JSON.parse(readFileSync("cli-upgrade-baseline.json", "utf8")).version }
    : {}),
  component: component!,
  files,
  sourceSha: process.env.GITHUB_SHA!,
  version: process.env.VERSION!,
  runId: Number(process.env.GITHUB_RUN_ID),
  runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  toolchain: {
    node: process.version,
    bun: execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(),
    platform: process.platform,
    arch: process.arch,
    image: [process.env.ImageOS ?? "unknown", process.env.ImageVersion ?? "unknown"].join("/"),
  },
};
mkdirSync("component-receipt", { recursive: true });
writeFileSync("component-receipt/receipt.json", JSON.stringify(receipt, null, 2) + "\n");
