// @effect-diagnostics nodeBuiltinImport:off
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256File } from "@t3tools/shared/cliRelease";
const dir = process.argv[2];
if (!dir) throw new Error("Expected asset directory");
const lines = await Promise.all(
  readdirSync(dir)
    .filter((name) => name !== "SHA256SUMS")
    .sort()
    .map(async (name) => `${await sha256File(join(dir, name))}  ${name}`),
);
writeFileSync(join(dir, "SHA256SUMS"), lines.join("\n") + "\n");
