import { spawn } from "node:child_process";
import * as NodePath from "node:path";

const PATH_CAPTURE_START = "__T3CODE_PATH_START__";
const PATH_CAPTURE_END = "__T3CODE_PATH_END__";
const SHELL_ENV_NAME_PATTERN = /^[A-Z0-9_]+$/;

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
  const isNushell = NodePath.basename(shell).toLowerCase().startsWith("nu");

  return names
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
