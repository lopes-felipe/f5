import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import * as NodePath from "node:path";

const PATH_CAPTURE_START = "__T3CODE_PATH_START__";
const PATH_CAPTURE_END = "__T3CODE_PATH_END__";
const SHELL_ENV_NAME_PATTERN = /^[A-Z0-9_]+$/;
const DEBUG_TRAP_SHELLS = new Set(["bash", "zsh", "sh", "ksh", "ksh93"]);

export const LOGIN_SHELL_PATH_ENV_NAMES = ["PATH", "__MISE_DIFF", "FNM_MULTISHELL_PATH"] as const;

function isWithinDirectory(entry: string, directory: string): boolean {
  return entry === directory || entry.startsWith(directory + "/");
}

async function hasExecutableNode(bin: string): Promise<boolean> {
  const node = bin + "/node";
  try {
    if (!(await stat(node)).isFile()) return false;
    await access(node, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function applyLoginShellPath(
  env: NodeJS.ProcessEnv,
  shellEnvironment: Partial<Record<string, string>>,
  inheritedMultishell: string | undefined,
): Promise<boolean> {
  let entries = shellEnvironment.PATH?.split(":");
  if (!entries?.some((entry) => entry.trim())) return false;

  let multishell = shellEnvironment.FNM_MULTISHELL_PATH;
  if (
    multishell &&
    inheritedMultishell &&
    multishell !== inheritedMultishell &&
    entries.some((entry) => isWithinDirectory(entry, inheritedMultishell))
  ) {
    const bin = multishell + "/bin";
    // Without a default version, fnm can prepend a dangling multishell symlink.
    // Keep the inherited directory and discard the failed replacement in that case.
    const canReplace = entries.includes(bin) && (await hasExecutableNode(bin));
    const discarded = canReplace ? inheritedMultishell : multishell;
    const retained = canReplace ? multishell : inheritedMultishell;
    entries = entries.filter((entry) => !isWithinDirectory(entry, discarded));
    // Overlapping directories can make pruning unsafe even if other PATH entries survive.
    if (!entries.some((entry) => isWithinDirectory(entry, retained))) return false;
    multishell = retained;
  }

  env.PATH = entries.join(":");
  if (multishell) env.FNM_MULTISHELL_PATH = multishell;
  // mise needs its PATH record to avoid rebuilding PATH behind same-named wrappers.
  if (shellEnvironment.__MISE_DIFF) env.__MISE_DIFF = shellEnvironment.__MISE_DIFF;
  return true;
}

export function extractPathFromShellOutput(output: string): string | null {
  const startIndex = output.indexOf(PATH_CAPTURE_START);
  if (startIndex === -1) return null;

  const valueStartIndex = startIndex + PATH_CAPTURE_START.length;
  const endIndex = output.indexOf(PATH_CAPTURE_END, valueStartIndex);
  if (endIndex === -1) return null;

  const pathValue = output.slice(valueStartIndex, endIndex).trim();
  return pathValue.length > 0 ? pathValue : null;
}

function envCaptureStart(name: string): string {
  return `__T3CODE_ENV_${name}_START__`;
}

function envCaptureEnd(name: string): string {
  return `__T3CODE_ENV_${name}_END__`;
}

export function buildEnvironmentCaptureCommand(
  shell: string,
  names: ReadonlyArray<string>,
): string {
  // Nushell rejects the POSIX probe (`||`), so it reads its environment natively.
  const executableName = NodePath.basename(shell).toLowerCase();
  const isNushell = executableName.startsWith("nu");

  const capture = names
    .map((name) => {
      if (!SHELL_ENV_NAME_PATTERN.test(name)) {
        throw new Error(`Unsupported environment variable name: ${name}`);
      }

      if (isNushell) {
        // Without a configured conversion, Nu expands home paths only in a list PATH.
        const defaultValue =
          name === "PATH"
            ? "if ($env.PATH? | describe | str starts-with 'list') { " +
              "$env.PATH | each {|p| if ($p | str starts-with '~') { " +
              "$p | path expand --no-symlink } else { $p } } | str join (char esep) " +
              "} else { $env.PATH? | default '' }"
            : `$env.${name}? | default ''`;
        const value =
          `if $env.${name}? == null { '' } else if ` +
          `$env.ENV_CONVERSIONS?.${name}?.to_string? != null { ` +
          `$env.${name} | do $env.ENV_CONVERSIONS.${name}.to_string $env.${name} ` +
          `} else { ${defaultValue} }`;
        return [
          `print '${envCaptureStart(name)}'`,
          `print (${value})`,
          `print '${envCaptureEnd(name)}'`,
        ].join("; ");
      }

      return [
        `printf '%s\\n' '${envCaptureStart(name)}'`,
        `printenv ${name} || true`,
        `printf '%s\\n' '${envCaptureEnd(name)}'`,
      ].join("; ");
    })
    .join("; ");

  // DEBUG title hooks can echo the probe markers before printf writes them.
  // Test support in a subshell because some shells exit on an unsupported trap.
  return capture && DEBUG_TRAP_SHELLS.has(executableName)
    ? `(trap - DEBUG) 2>/dev/null && trap - DEBUG; ${capture}`
    : capture;
}

function extractEnvironmentValue(output: string, name: string): string | undefined {
  const startMarker = envCaptureStart(name);
  const endMarker = envCaptureEnd(name);
  const startIndex = output.indexOf(startMarker);
  if (startIndex === -1) return undefined;

  const valueStartIndex = startIndex + startMarker.length;
  const endIndex = output.indexOf(endMarker, valueStartIndex);
  if (endIndex === -1) return undefined;

  let value = output.slice(valueStartIndex, endIndex);
  if (value.startsWith("\n")) {
    value = value.slice(1);
  }
  if (value.endsWith("\n")) {
    value = value.slice(0, -1);
  }

  return value.length > 0 ? value : undefined;
}

export type ShellEnvironmentReader = (
  shell: string,
  names: ReadonlyArray<string>,
) => Partial<Record<string, string>> | Promise<Partial<Record<string, string>>>;

/** Startup probes must stop waiting even when the OS cannot reap a killed shell. */
export async function readEnvironmentFromLoginShellAsync(
  shell: string,
  names: ReadonlyArray<string>,
  execute: typeof spawn = spawn,
): Promise<Partial<Record<string, string>>> {
  if (names.length === 0) return {};
  const command = buildEnvironmentCaptureCommand(shell, names);
  const output = await new Promise<string>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 5000);
    const timer = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      reject(new Error("Login shell environment probe timed out."));
    }, 6000);
    try {
      child = execute(shell, ["-ilc", command], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let stdout = "";
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.length > 1024 * 1024) {
          child.kill("SIGKILL");
          child.stdout?.destroy();
          child.unref();
          clearTimeout(timer);
          clearTimeout(killTimer);
          reject(new Error("Login shell environment output exceeded its limit."));
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        if (code === 0) resolve(stdout);
        else
          reject(
            new Error(
              timedOut
                ? "Login shell environment probe timed out."
                : "Login shell environment probe failed.",
            ),
          );
      });
    } catch (error) {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(error);
    }
  });
  return extractEnvironment(output, names);
}

function extractEnvironment(
  output: string,
  names: ReadonlyArray<string>,
): Partial<Record<string, string>> {
  const environment: Partial<Record<string, string>> = {};
  for (const name of names) {
    const value = extractEnvironmentValue(output, name);
    if (value !== undefined) {
      environment[name] = value;
    }
  }

  return environment;
}
