import { assertExecutionDirectory } from "../profiles/executionDirectory";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import type { ServerConfigShape } from "../config";
import { buildAccountExecutionEnvironment } from "../providerProcessEnv";
import { runProcess } from "../processRunner";

const helperSource = String.raw`let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  if (process.argv[2] !== "get") return;
  const fields = Object.fromEntries(input.trim().split(/\n/).map(line => { const i = line.indexOf("="); return [line.slice(0,i), line.slice(i+1)]; }));
  if (fields.protocol !== "https" || fields.host !== process.env.F5_GIT_CREDENTIAL_HOST || !process.env.F5_GIT_CREDENTIAL_TOKEN) return;
  process.stdout.write("username=x-access-token\npassword=" + process.env.F5_GIT_CREDENTIAL_TOKEN + "\n\n");
});
`;
const preparedHelpers = new Map<string, Promise<string>>();
function credentialHelper(stateDir: string): Promise<string> {
  let pending = preparedHelpers.get(stateDir);
  if (!pending) {
    pending = (async () => {
      const directory = Path.join(stateDir, "git");
      await FS.mkdir(directory, { recursive: true, mode: 0o700 });
      const target = Path.join(directory, "credential-helper.cjs");
      await FS.writeFile(target, helperSource, { mode: 0o600 });
      return target;
    })();
    preparedHelpers.set(stateDir, pending);
    void pending.catch(() => preparedHelpers.delete(stateDir));
  }
  return pending;
}
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
export async function profileGitEnvironment(input: {
  config: ServerConfigShape;
  cwd: string;
  args: readonly string[];
  overrides?: NodeJS.ProcessEnv | undefined;
  authorName: string;
  authorEmail: string;
  tokenForHost: (host: string) => Promise<string | null>;
}): Promise<NodeJS.ProcessEnv> {
  if (input.config.profile) await assertExecutionDirectory(input.cwd);
  const environment = buildAccountExecutionEnvironment({
    purpose: "git",
    profile: input.config.profile,
    stateDir: input.config.stateDir,
    baseEnv: process.env,
  });
  for (const key of Object.keys(environment))
    if (
      /^(?:GIT_CONFIG_|GIT_AUTHOR_|GIT_COMMITTER_|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GIT_SSH|GIT_SSH_COMMAND|GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|F5_GIT_CREDENTIAL_)/i.test(
        key,
      )
    )
      delete environment[key];
  for (const [key, value] of Object.entries(input.overrides ?? {}))
    if (
      !/^(?:GIT_CONFIG_|GIT_AUTHOR_|GIT_COMMITTER_|GIT_ASKPASS|SSH_|GIT_SSH|GH_|GITHUB_|F5_|T3CODE_)/i.test(
        key,
      )
    )
      environment[key] = value;
  environment.GIT_CONFIG_GLOBAL = Path.join(input.config.stateDir, "gitconfig");
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_TERMINAL_PROMPT = "0";
  const pairs: [string, string][] = [
    ["credential.helper", ""],
    ["http.extraHeader", ""],
  ];
  if (input.authorName && input.authorEmail) {
    environment.GIT_AUTHOR_NAME = environment.GIT_COMMITTER_NAME = input.authorName;
    environment.GIT_AUTHOR_EMAIL = environment.GIT_COMMITTER_EMAIL = input.authorEmail;
  } else if (input.args[0] === "commit")
    throw new Error(
      "Set this profile's Git author name and email in Settings > Integrations before committing.",
    );
  const operation = input.args[0];
  if (
    operation === "push" ||
    operation === "pull" ||
    operation === "fetch" ||
    operation === "ls-remote" ||
    operation === "clone"
  ) {
    if (
      operation === "fetch" &&
      (input.args.includes("--all") || input.args.includes("--multiple"))
    )
      throw new Error(
        "Fetch one named remote at a time so its profile credentials can be validated.",
      );
    const argumentsWithValues = new Set([
      "--depth",
      "--deepen",
      "--shallow-since",
      "--shallow-exclude",
      "--filter",
      "--upload-pack",
      "--receive-pack",
      "--repo",
      "--recurse-submodules",
      "--server-option",
      "--negotiation-tip",
      "--jobs",
      "-j",
      "--branch",
      "-b",
      "--origin",
      "-o",
      "--reference",
      "--reference-if-able",
      "--separate-git-dir",
      "--template",
      "--config",
      "-c",
    ]);
    let positional: string | undefined;
    for (let index = 1; index < input.args.length; index++) {
      const argument = input.args[index]!;
      if (argument === "--") {
        positional = input.args[index + 1];
        break;
      }
      if (argumentsWithValues.has(argument)) {
        index++;
        continue;
      }
      if (!argument.startsWith("-")) {
        positional = argument;
        break;
      }
    }
    let remote = positional ?? "origin";
    if (!remote.includes(":") && !remote.includes("/") && !remote.includes("\\")) {
      const result = await runProcess(
        "git",
        ["remote", "get-url", "--all", ...(operation === "push" ? ["--push"] : []), remote],
        {
          cwd: input.cwd,
          env: environment,
          allowNonZeroExit: true,
          timeoutMs: 10000,
        },
      );
      if (result.code === 0) remote = result.stdout.trim();
    }
    if (remote.includes("\n"))
      throw new Error("Use a single HTTPS remote URL for profile-authenticated operations.");
    if (remote.startsWith("ssh:") || /^[^/]+@[^:]+:/.test(remote))
      throw new Error(
        "Profile-authenticated Git operations require an HTTPS GitHub remote. Update the remote URL to HTTPS.",
      );
    if (/^https?:/.test(remote)) {
      const url = new URL(remote);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("Use an HTTPS remote without embedded credentials.");
      const rewrites = await runProcess(
        "git",
        ["config", "--name-only", "--get-regexp", "^url\\..*\\.(insteadof|pushinsteadof)$"],
        {
          cwd: input.cwd,
          env: environment,
          allowNonZeroExit: true,
          timeoutMs: 10000,
        },
      );
      if (rewrites.stdout.trim())
        throw new Error(
          "Profile-authenticated operations require explicit HTTPS remotes without Git URL rewrite rules. Update the repository's remote configuration.",
        );
      const localAuthentication = await runProcess(
        "git",
        [
          "config",
          "--name-only",
          "--get-regexp",
          "^(credential(\\..*)?\\.helper|http(\\..*)?\\.extraheader)$",
        ],
        {
          cwd: input.cwd,
          env: environment,
          allowNonZeroExit: true,
          timeoutMs: 10000,
        },
      );
      for (const key of new Set(localAuthentication.stdout.split(/\r?\n/).filter(Boolean)))
        if (!pairs.some(([existing]) => existing.toLowerCase() === key.toLowerCase()))
          pairs.push([key, ""]);
      const token = await input.tokenForHost(url.hostname.toLowerCase());
      if (!token)
        throw new Error(
          `Connect ${url.hostname} in Settings > Integrations before using this remote.`,
        );
      const helper = await credentialHelper(input.config.stateDir);
      pairs.push(["credential.helper", `!${shellQuote(process.execPath)} ${shellQuote(helper)}`]);
      environment.F5_GIT_CREDENTIAL_HOST = url.host;
      environment.F5_GIT_CREDENTIAL_TOKEN = token;
    }
  }
  environment.GIT_CONFIG_COUNT = String(pairs.length);
  pairs.forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return environment;
}
