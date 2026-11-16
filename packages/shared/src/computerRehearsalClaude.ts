import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

export function rehearsalClaudeAuthentication(stdout: unknown, credentialFileCopied: boolean) {
  let authenticated: unknown;
  try {
    if (typeof stdout === "string") authenticated = JSON.parse(stdout)?.loggedIn;
  } catch {
    /* Never retain raw CLI errors or account metadata. */
  }
  return {
    status:
      authenticated === true
        ? "authenticated"
        : authenticated === false
          ? "unauthenticated"
          : "unknown",
    credentialFileCopied,
    selectedProfileSecureStorage: true,
  } as const;
}

export async function prepareRehearsalClaude(input: {
  binary: string;
  sourceHome: string;
  isolatedHome: string;
  root: string;
}) {
  const config = join(input.isolatedHome, ".claude");
  await mkdir(config, { recursive: true, mode: 0o700 });
  let credentialFileCopied = false;
  try {
    await copyFile(
      join(input.sourceHome, ".claude/.credentials.json"),
      join(config, ".credentials.json"),
    );
    await chmod(join(config, ".credentials.json"), 0o600);
    credentialFileCopied = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Selected credential file unavailable.");
  }
  // The SDK recognizes .js as a script; it treats .cjs as a native executable
  // even when its caller supplies executable: "node".
  const binary = join(input.root, "claude-launch.js");
  await writeFile(binary, rehearsalClaudeLaunch(input.binary, join(input.sourceHome, ".claude")), {
    mode: 0o600,
    flag: "wx",
  });
  let stdout: unknown;
  try {
    stdout = (
      await promisify(execFile)("node", [binary, "auth", "status", "--json"], {
        cwd: input.root,
        timeout: 15000,
        maxBuffer: 8192,
        env: {
          PATH: process.env.PATH,
          CLAUDE_CONFIG_DIR: config,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
      })
    ).stdout;
  } catch (error) {
    stdout = (error as { stdout?: unknown }).stdout;
  }
  return { binary, authentication: rehearsalClaudeAuthentication(stdout, credentialFileCopied) };
}

/** Node rehearsal only: reuse the explicitly selected account's secure storage while
 * retaining the isolated CLI config/transcript directory supplied by F5. Never
 * copies user settings, plugins, transcripts or keychain contents. */
export function rehearsalClaudeLaunch(binary: string, credentialDirectory: string): string {
  if (!isAbsolute(binary) || !isAbsolute(credentialDirectory))
    throw new Error("Rehearsal paths must be absolute.");
  return `
const {spawn}=require('node:child_process');
const {userInfo}=require('node:os');
const user=userInfo();
const child=spawn(${JSON.stringify(binary)},process.argv.slice(2),{
  stdio:'inherit',
  env:{...process.env,HOME:user.homedir,USER:user.username,
    CLAUDE_SECURESTORAGE_CONFIG_DIR:${JSON.stringify(credentialDirectory)}}
});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill(signal));
child.once('error',()=>process.exit(1));
child.once('exit',code=>process.exit(code??1));
`;
}

/** Keep F5's bundled SDK selection and profile compatibility checks intact.
 * This test-only bootstrap supplies the explicitly selected account namespace
 * to Claude processes in this one isolated home, leaving config/transcripts private. */
export function rehearsalClaudeBackendBootstrap(
  backendEntry: string,
  isolatedRoot: string,
  credentialDirectory: string,
): string {
  if (![backendEntry, isolatedRoot, credentialDirectory].every(isAbsolute))
    throw new Error("Rehearsal paths must be absolute.");
  return `
const cp=require('node:child_process');
const {basename,relative,isAbsolute,sep}=require('node:path');
const {userInfo}=require('node:os');
const {syncBuiltinESMExports}=require('node:module');
const {pathToFileURL}=require('node:url');
const spawn=cp.spawn;
cp.spawn=function(file,args,options){
  const config=options?.env?.CLAUDE_CONFIG_DIR;
  const scope=typeof config==='string'?relative(${JSON.stringify(isolatedRoot)},config):null;
  if(typeof file==='string'&&isAbsolute(file)&&basename(file)==='claude'&&
     scope!==null&&scope!==''&&scope!=='..'&&!scope.startsWith('..'+sep)&&!isAbsolute(scope)){
    const user=userInfo();
    options={...options,env:{...options.env,HOME:user.homedir,USER:user.username,
      CLAUDE_SECURESTORAGE_CONFIG_DIR:${JSON.stringify(credentialDirectory)}}};
  }
  return spawn.call(this,file,args,options);
};
syncBuiltinESMExports();
process.argv[1]=${JSON.stringify(backendEntry)};
import(pathToFileURL(process.argv[1]).href).catch(()=>process.exit(1));
`;
}
