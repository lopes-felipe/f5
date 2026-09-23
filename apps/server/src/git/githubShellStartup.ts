import * as FS from "node:fs/promises";
import * as Path from "node:path";

const shellDir = (stateDir: string) => Path.join(stateDir, "github-shells");
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

/** Retain normal user startup, then restore the profile CLI entry point. */
export function githubShellEnvironment(
  env: NodeJS.ProcessEnv,
  stateDir: string,
): NodeJS.ProcessEnv {
  const directory = shellDir(stateDir);
  return {
    ...env,
    F5_GITHUB_ORIGINAL_ZDOTDIR:
      env.ZDOTDIR === directory ? env.F5_GITHUB_ORIGINAL_ZDOTDIR : (env.ZDOTDIR ?? env.HOME ?? ""),
    F5_GITHUB_ORIGINAL_BASH_ENV:
      env.BASH_ENV === Path.join(directory, "bash-env")
        ? env.F5_GITHUB_ORIGINAL_BASH_ENV
        : (env.BASH_ENV ?? ""),
    ZDOTDIR: directory,
    BASH_ENV: Path.join(directory, "bash-env"),
  };
}

export async function prepareGithubShellStartup(stateDir: string): Promise<void> {
  const directory = shellDir(stateDir);
  await FS.mkdir(directory, { recursive: true, mode: 0o700 });
  const reset = `unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN GH_DEBUG\nexport GH_CONFIG_DIR=${quote(Path.join(stateDir, "github"))}\nexport PATH=${quote(Path.join(stateDir, "github-bin"))}:"$PATH"\n`;
  for (const name of [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"]) {
    await FS.writeFile(
      Path.join(directory, name),
      `ZDOTDIR="$F5_GITHUB_ORIGINAL_ZDOTDIR"\nif [ -r "$ZDOTDIR/${name}" ]; then . "$ZDOTDIR/${name}"; fi\nexport F5_GITHUB_ORIGINAL_ZDOTDIR="\${ZDOTDIR:-$HOME}"\n${reset}export ZDOTDIR=${quote(directory)}\n`,
      { mode: 0o600 },
    );
  }
  await FS.writeFile(
    Path.join(directory, "bash-env"),
    `if [ -n "$F5_GITHUB_ORIGINAL_BASH_ENV" ] && [ -r "$F5_GITHUB_ORIGINAL_BASH_ENV" ]; then . "$F5_GITHUB_ORIGINAL_BASH_ENV"; fi\n${reset}`,
    { mode: 0o600 },
  );
  await FS.writeFile(
    Path.join(directory, "bashrc"),
    `if [ "$F5_GITHUB_LOGIN_SHELL" = 1 ]; then
  [ ! -r /etc/profile ] || . /etc/profile
  for file in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
    if [ -r "$file" ]; then . "$file"; break; fi
  done
else
  [ ! -r "$HOME/.bashrc" ] || . "$HOME/.bashrc"
fi
${reset}`,
    { mode: 0o600 },
  );
}

export function githubTerminalStartup(
  shell: string,
  args: string[] | undefined,
  env: NodeJS.ProcessEnv,
  stateDir: string,
): { args: string[]; env: NodeJS.ProcessEnv } {
  const name = shell
    .split(/[\\/]/)
    .at(-1)
    ?.toLowerCase()
    .replace(/\.exe$/, "");
  const original = args ?? [];
  const base = githubShellEnvironment(env, stateDir);
  if (name === "bash")
    return {
      args: [
        "--noprofile",
        "--rcfile",
        Path.join(shellDir(stateDir), "bashrc"),
        ...original.filter((arg) => arg !== "-l" && arg !== "--login"),
        ...(original.includes("-i") ? [] : ["-i"]),
      ],
      env: {
        ...base,
        F5_GITHUB_LOGIN_SHELL: original.includes("-l") || original.includes("--login") ? "1" : "0",
      },
    };
  const bin = Path.join(stateDir, "github-bin");
  const config = Path.join(stateDir, "github");
  if (name === "powershell" || name === "pwsh") {
    const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    return {
      env: base,
      args: [
        ...original,
        "-NoExit",
        "-Command",
        `$env:PATH = ${literal(bin)} + [IO.Path]::PathSeparator + $env:PATH; $env:GH_CONFIG_DIR = ${literal(config)}; 'GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN','GH_DEBUG' | ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }`,
      ],
    };
  }
  if (name === "cmd")
    return {
      env: { ...base, F5_GITHUB_BIN: bin, F5_GITHUB_CONFIG: config },
      args: [
        ...original,
        "/k",
        'set "PATH=%F5_GITHUB_BIN%;%PATH%" & set "GH_CONFIG_DIR=%F5_GITHUB_CONFIG%" & set "GH_TOKEN=" & set "GITHUB_TOKEN=" & set "GH_ENTERPRISE_TOKEN=" & set "GITHUB_ENTERPRISE_TOKEN=" & set "GH_DEBUG="',
      ],
    };
  if (name === "fish")
    return {
      env: base,
      args: [
        ...original,
        "--init-command",
        `set -gx PATH ${quote(bin)} $PATH; set -gx GH_CONFIG_DIR ${quote(config)}; set -e GH_TOKEN; set -e GITHUB_TOKEN; set -e GH_ENTERPRISE_TOKEN; set -e GITHUB_ENTERPRISE_TOKEN; set -e GH_DEBUG`,
      ],
    };
  return { env: base, args: original };
}
