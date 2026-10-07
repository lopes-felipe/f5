import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseCodexCliVersion } from "@t3tools/shared/codexCliVersion";
import {
  extractCodexTaggedUnionValues,
  checkCodexClientRequests,
} from "@t3tools/shared/codexProtocolAudit";
import { codexRequestShapeProbe } from "./codexRequestShapeAudit.ts";

const PINNED_VERSION = "0.160.1";
async function command(file: string, args: string[]) {
  const child = Bun.spawn([file, ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${file} failed: ${err || out}`);
  return out.trim();
}
const root = path.resolve(import.meta.dirname, "..");
// Keep the probe beside scripts so workspace package imports resolve normally.
const probeDirectory = await mkdtemp(path.join(root, "scripts/.codex-request-audit-"));
const temporary = await mkdtemp(path.join(tmpdir(), "f5-codex-request-shapes-"));
try {
  let binary = process.env.CODEX_BINARY_PATH ?? "codex";
  if (process.argv.includes("--install-baseline")) {
    const platformPackage = `@openai/codex-${process.platform}-${process.arch}`;
    await command("npm", [
      "install",
      "--prefix",
      temporary,
      "--no-save",
      "--omit=optional",
      "--fetch-retries=2",
      `@openai/codex@${PINNED_VERSION}`,
      `${platformPackage}@npm:@openai/codex@${PINNED_VERSION}-${process.platform}-${process.arch}`,
    ]);
    binary = path.join(
      temporary,
      "node_modules/.bin",
      process.platform === "win32" ? "codex.cmd" : "codex",
    );
  }
  const version = await command(binary, ["--version"]);
  if (parseCodexCliVersion(version) !== PINNED_VERSION)
    throw new Error(`Request audit requires ${PINNED_VERSION}; received ${version}`);
  const schemas = path.join(temporary, "schemas");
  await command(binary, ["app-server", "generate-ts", "--experimental", "--out", schemas]);
  const baseline = JSON.parse(
    await readFile(path.join(root, "scripts/fixtures/codex-requests/baseline.json"), "utf8"),
  ) as { cliVersion: string; sha256: Record<string, string> };
  if (baseline.cliVersion !== PINNED_VERSION) throw new Error("Request fixture version mismatch");
  for (const [file, checksum] of Object.entries(baseline.sha256)) {
    const generated = await readFile(path.join(schemas, file));
    if (createHash("sha256").update(generated).digest("hex") !== checksum)
      throw new Error(`Generated request schema drift: ${file}`);
  }
  const available = new Set(
    extractCodexTaggedUnionValues(
      await readFile(path.join(schemas, "ClientRequest.ts"), "utf8"),
      "method",
    ),
  );
  const groups = checkCodexClientRequests([...available]);
  for (const fallback of groups.usingFallback) console.log(`Fallback selected: ${fallback}`);
  for (const method of ["thread/revert", "thread/rollback", "thread/fork"])
    if (!available.has(method)) console.log(`Absent fallback method: ${method}`);
  if (groups.unsupported.length)
    throw new Error(`Unsupported client request groups: ${groups.unsupported.join(", ")}`);
  const probe = path.join(probeDirectory, "probe.ts");
  await writeFile(
    probe,
    codexRequestShapeProbe(
      path.join(root, "apps/server/src/codexAppServerManager.ts"),
      schemas,
      available,
    ),
  );
  const config = path.join(probeDirectory, "tsconfig.json");
  await writeFile(
    config,
    JSON.stringify({
      extends: path.join(root, "apps/server/tsconfig.json"),
      compilerOptions: {
        composite: false,
        incremental: false,
        plugins: [],
        typeRoots: [
          path.join(root, "apps/server/node_modules/@types"),
          path.join(root, "node_modules/@types"),
        ],
      },
      include: [],
      files: [probe],
    }),
  );
  await command("node", [
    path.join(root, "apps/server/node_modules/typescript/bin/tsc"),
    "--noEmit",
    "--project",
    config,
  ]);
  console.log(
    `Codex ${PINNED_VERSION}: all seven real request builders satisfy generated experimental types.`,
  );
} finally {
  await rm(probeDirectory, { recursive: true, force: true });
  await rm(temporary, { recursive: true, force: true });
}
