import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  rehearsalClaudeLaunch,
  rehearsalClaudeAuthentication,
  prepareRehearsalClaude,
  rehearsalClaudeBackendBootstrap,
} from "./computerRehearsalClaude";

it("keeps transcript state isolated and forwards CLI arguments with only selected credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "f5-claude-launch-test-"));
  try {
    const wrapper = join(root, "wrapper.cjs");
    const fixture = join(root, "fixture.cjs");
    const credentials = join(root, "selected-account ' $() ` credential scope");
    const config = join(root, "isolated-transcripts");
    await writeFile(wrapper, rehearsalClaudeLaunch(process.execPath, credentials));
    await writeFile(
      fixture,
      `process.stdout.write(JSON.stringify({
      args:process.argv.slice(2),config:process.env.CLAUDE_CONFIG_DIR,
      credentials:process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
      home:process.env.HOME,user:process.env.USER
    }));`,
    );
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [wrapper, fixture, "--sdk", "argument ' $() `"],
      {
        timeout: 10000,
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: config,
          CLAUDE_SECURESTORAGE_CONFIG_DIR: "another-account",
          HOME: root,
          USER: "synthetic-user",
        },
      },
    );
    expect(JSON.parse(stdout)).toEqual({
      args: ["--sdk", "argument ' $() `"],
      config,
      credentials,
      home: userInfo().homedir,
      user: userInfo().username,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses paths that would resolve against an unrelated working directory", () => {
  expect(() => rehearsalClaudeLaunch("claude", join(tmpdir(), "credentials"))).toThrow();
  expect(() => rehearsalClaudeLaunch(process.execPath, "relative-credentials")).toThrow();
});

it("preserves a native CLI failure without printing its arguments or credential location", async () => {
  const root = await mkdtemp(join(tmpdir(), "f5-claude-launch-exit-"));
  try {
    const wrapper = join(root, "wrapper.cjs");
    await writeFile(wrapper, rehearsalClaudeLaunch(process.execPath, join(root, "credentials")));
    await expect(
      promisify(execFile)(process.execPath, [wrapper, "-e", "process.exit(7)"], { timeout: 10000 }),
    ).rejects.toMatchObject({ code: 7, stdout: "", stderr: "" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("keeps only strict authentication state and discards account data and errors", () => {
  expect(
    rehearsalClaudeAuthentication('{"loggedIn":true,"email":"PRIVATE_SENTINEL"}', true),
  ).toEqual({
    status: "authenticated",
    credentialFileCopied: true,
    selectedProfileSecureStorage: true,
  });
  expect(rehearsalClaudeAuthentication('{"loggedIn":false}', false).status).toBe("unauthenticated");
  for (const value of [
    null,
    undefined,
    '{"loggedIn":"true"}',
    '{"loggedIn":1}',
    "PRIVATE_SENTINEL",
  ]) {
    const result = rehearsalClaudeAuthentication(value, false);
    expect(result.status).toBe("unknown");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
  }
});
it("prepares an SDK-recognized script and copies only the selected credential file privately", async () => {
  const root = await mkdtemp(join(tmpdir(), "f5-claude-prepare-test-"));
  try {
    const sourceHome = join(root, "source");
    const isolatedHome = join(root, "isolated");
    await mkdir(join(sourceHome, ".claude"), { recursive: true });
    await writeFile(
      join(sourceHome, ".claude/.credentials.json"),
      '{"synthetic":"PRIVATE_SENTINEL"}',
    );
    await writeFile(join(sourceHome, ".claude/settings.json"), '{"hooks":"PRIVATE_SENTINEL"}');
    const result = await prepareRehearsalClaude({
      binary: process.execPath,
      root,
      sourceHome,
      isolatedHome,
    });
    expect(result.binary).toBe(join(root, "claude-launch.js"));
    expect(result.authentication.credentialFileCopied).toBe(true);
    expect(JSON.stringify(result.authentication)).not.toContain("PRIVATE_SENTINEL");
    expect(await readFile(join(isolatedHome, ".claude/.credentials.json"), "utf8")).toBe(
      '{"synthetic":"PRIVATE_SENTINEL"}',
    );
    if (process.platform !== "win32")
      expect((await stat(join(isolatedHome, ".claude/.credentials.json"))).mode & 0o777).toBe(
        0o600,
      );
    await expect(stat(join(isolatedHome, ".claude/settings.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("keeps the bundled CLI and backend entry intact and scopes account borrowing to the private installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "f5-claude-backend-test-"));
  try {
    const app = join(root, "app");
    const account = join(root, "selected-account");
    const bootstrap = join(root, "bootstrap.cjs");
    const backend = join(root, "backend.cjs");
    const launcher = join(root, "test.cjs");
    const cli = join(root, "sdk", "claude");
    const config = join(app, "userdata", "provider-homes", "claude", ".claude");
    const outside = join(root, "application", ".claude");
    await writeFile(
      bootstrap,
      rehearsalClaudeBackendBootstrap(backend, app, account).replace(
        ".catch(()=>process.exit(1))",
        ".catch(error=>{console.error(error);process.exit(1)})",
      ),
    );
    await writeFile(
      backend,
      `
const cp=require('node:child_process'),calls=globalThis.calls;
const env={CLAUDE_CONFIG_DIR:${JSON.stringify(config)},CLAUDE_SECURESTORAGE_CONFIG_DIR:'private',HOME:'private',USER:'private'};
cp.spawn(${JSON.stringify(cli)},['--sdk'],{env});
cp.spawn(${JSON.stringify(cli)},['--version'],{env:{...env,CLAUDE_CONFIG_DIR:${JSON.stringify(outside)}}});
cp.spawn(${JSON.stringify(process.execPath)},['hook.js'],{env});
cp.spawn('claude',['--sdk'],{env});
const user=require('node:os').userInfo();
process.stdout.write(JSON.stringify({
  entryPreserved:process.argv[1]===${JSON.stringify(backend)},
  cliUnchanged:calls[0].file===${JSON.stringify(cli)}&&calls[0].args[0]==='--sdk',
  configUnchanged:calls[0].options.env.CLAUDE_CONFIG_DIR===env.CLAUDE_CONFIG_DIR,
  selectedAccount:calls[0].options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR===${JSON.stringify(account)},
  realLoginContext:calls[0].options.env.HOME===user.homedir&&calls[0].options.env.USER===user.username,
  outsideUnchanged:calls[1].options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR==='private',
  hookUnchanged:calls[2].options.env===env,relativeCliUnchanged:calls[3].options.env===env,
  originalUnchanged:env.CLAUDE_SECURESTORAGE_CONFIG_DIR==='private'
}));`,
    );
    await writeFile(
      launcher,
      `globalThis.calls=[];require('node:child_process').spawn=(file,args,options)=>{
globalThis.calls.push({file,args,options});return {};};require(${JSON.stringify(bootstrap)});`,
    );
    const { stdout } = await promisify(execFile)(process.execPath, [launcher], { timeout: 10000 });
    expect(JSON.parse(stdout)).toEqual({
      entryPreserved: true,
      cliUnchanged: true,
      configUnchanged: true,
      selectedAccount: true,
      realLoginContext: true,
      outsideUnchanged: true,
      hookUnchanged: true,
      relativeCliUnchanged: true,
      originalUnchanged: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
