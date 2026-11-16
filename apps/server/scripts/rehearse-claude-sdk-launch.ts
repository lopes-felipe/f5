import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
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
const model = argument("--model") ?? "claude-fable-5-1";
if (process.platform !== "darwin" || !sourceHome || !binary || !output) {
  process.stderr.write(
    "Usage on macOS: bun apps/server/scripts/rehearse-claude-sdk-launch.ts --claude-home <selected profile home> --claude-binary <native SDK CLI> --output <new report.json>\n",
  );
  process.exit(1);
}
await writeFile(resolve(output), "", { flag: "wx" });
const root = await mkdtemp(join(tmpdir(), "f5-claude-sdk-preflight-"));
const exec = promisify(execFile);
let session: ReturnType<typeof query> | undefined;
let endInput = () => {};
let timer: ReturnType<typeof setTimeout> | undefined;
let repositoryCommit, workingTreeDirty, launchSourceSha256, cliSha256, authentication;
let sdkInitialized = false,
  selectedModelListed = false;
let stage = "preparation",
  failureStage;
try {
  repositoryCommit = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
  workingTreeDirty = !!(await exec("git", ["status", "--porcelain"])).stdout.trim();
  launchSourceSha256 = createHash("sha256")
    .update(
      await readFile(
        resolve(import.meta.dirname, "../../../packages/shared/src/computerRehearsalClaude.ts"),
      ),
    )
    .digest("hex");
  cliSha256 = createHash("sha256")
    .update(await readFile(resolve(binary)))
    .digest("hex");
  const home = join(root, "claude-home");
  stage = "authentication";
  const prepared = await prepareRehearsalClaude({
    root,
    isolatedHome: home,
    sourceHome: resolve(sourceHome),
    binary: resolve(binary),
  });
  authentication = prepared.authentication;
  if (authentication.status !== "authenticated") throw new Error("Authentication unavailable.");
  const stop = new Promise<void>((done) => {
    endInput = done;
  });
  const input: AsyncIterable<SDKUserMessage> = {
    async *[Symbol.asyncIterator]() {
      await stop;
    },
  };
  stage = "sdk-initialization";
  session = query({
    prompt: input,
    options: {
      cwd: root,
      pathToClaudeCodeExecutable: prepared.binary,
      executable: "node",
      settingSources: [],
      persistSession: false,
      model,
      env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: join(home, ".claude") },
      extraArgs: { "no-chrome": null },
      stderr: () => {},
      canUseTool: async () => ({
        behavior: "deny",
        message: "Read-only launch preflight: no tool execution.",
      }),
    },
  });
  const timeout = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error("SDK preflight timed out.")), 15000);
  });
  await Promise.race([session.initializationResult(), timeout]);
  sdkInitialized = true;
  stage = "model-metadata";
  selectedModelListed = (await Promise.race([session.supportedModels(), timeout])).some(
    (candidate) => candidate.value === model,
  );
  if (!selectedModelListed) throw new Error("Selected model is not listed.");
} catch {
  failureStage = stage;
} finally {
  if (timer) clearTimeout(timer);
  endInput();
  session?.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
const passed = sdkInitialized && selectedModelListed && !failureStage;
await writeFile(
  resolve(output),
  JSON.stringify(
    {
      reportVersion: 1,
      recordedAt: new Date().toISOString(),
      scope: "read-only-claude-sdk-launch-preflight",
      platform: process.platform,
      arch: process.arch,
      repositoryCommit,
      workingTreeDirty,
      launchSourceSha256,
      cliSha256,
      provider: "claude",
      state: passed ? "passed" : "failed",
      authentication,
      sdkInitialized,
      selectedModelListed,
      ...(failureStage ? { failureStage } : {}),
      providerTurnsStarted: 0,
      desktopActionsEmitted: 0,
      signed: false,
      certified: false,
      limitations: [
        "SDK startup/account/model metadata only; no prompt, tool call, app consent, capture or OS input",
        "Does not prove the Electron provider-to-desktop path or open a release gate",
      ],
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(
  `Read-only Claude SDK launch: ${passed ? "passed" : "failed"}; report ${resolve(output)}.\n`,
);
if (!passed) process.exitCode = 1;
