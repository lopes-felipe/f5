import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { prepareRehearsalClaude } from "@t3tools/shared/computerRehearsalClaude";

const args = process.argv.slice(2);
const argument = (name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const sourceHome = argument("--claude-home");
const binary = argument("--claude-binary");
const output = argument("--output");
if (process.platform !== "darwin" || !sourceHome || !binary || !output) {
  process.stderr.write(
    "Usage on macOS: bun apps/desktop/src/computer/rehearseClaudeAuthMacos.ts --claude-home <selected profile home> --claude-binary <native SDK CLI> --output <new report.json>\n",
  );
  process.exit(1);
}
await writeFile(resolve(output), "", { flag: "wx" });
const root = await mkdtemp(join(tmpdir(), "f5-claude-account-preflight-"));
const exec = promisify(execFile);
let authentication;
let repositoryCommit;
let workingTreeDirty;
let launchSourceSha256;
let cliSha256;
let failureCode;
try {
  repositoryCommit = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
  workingTreeDirty = !!(await exec("git", ["status", "--porcelain"])).stdout.trim();
  launchSourceSha256 = createHash("sha256")
    .update(
      await readFile(
        resolve(import.meta.dirname, "../../../../packages/shared/src/computerRehearsalClaude.ts"),
      ),
    )
    .digest("hex");
  cliSha256 = createHash("sha256")
    .update(await readFile(resolve(binary)))
    .digest("hex");
  authentication = (
    await prepareRehearsalClaude({
      binary: resolve(binary),
      sourceHome: resolve(sourceHome),
      isolatedHome: join(root, "claude-home"),
      root,
    })
  ).authentication;
} catch {
  failureCode = "preflight-failure";
} finally {
  await rm(root, { recursive: true, force: true });
}
const ready = authentication?.status === "authenticated" && !failureCode;
await writeFile(
  resolve(output),
  JSON.stringify(
    {
      reportVersion: 1,
      recordedAt: new Date().toISOString(),
      scope: "read-only-claude-isolated-account-preflight",
      platform: process.platform,
      arch: process.arch,
      repositoryCommit,
      workingTreeDirty,
      launchSourceSha256,
      cliSha256,
      provider: "claude",
      state: ready ? "ready" : "blocked",
      authentication,
      ...(failureCode ? { failureCode } : {}),
      signed: false,
      certified: false,
      providerTurnsStarted: 0,
      desktopActionsEmitted: 0,
      limitations: [
        "Only the explicitly selected profile credential scope was probed; no fallback to another account",
        "A fresh isolated CLI probe does not establish the authentication state of an existing F5 session",
        "No provider quota, app consent, screenshots, desktop input or computer-control certification",
      ],
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(
  `Claude account preflight: ${ready ? "ready" : "blocked"}; report ${resolve(output)}. No desktop input was emitted.\n`,
);
if (!ready) process.exitCode = 1;
