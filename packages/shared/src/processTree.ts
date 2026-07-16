import { spawnSync } from "node:child_process";
import * as NodePath from "node:path";

export interface ProcessTreeChild {
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface KillProcessTreeOptions {
  readonly isGroupLeader: boolean;
  readonly graceful?: boolean;
  readonly signal?: NodeJS.Signals;
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly spawnTaskkill?: (
    file: string,
    args: ReadonlyArray<string>,
    options: { readonly stdio: "ignore"; readonly timeout: number },
  ) => { readonly status: number | null; readonly error?: Error | undefined };
  readonly killPid?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface KillProcessTreeResult {
  readonly terminated: boolean;
  readonly usedFallback: boolean;
  readonly taskkillStatus?: number | null;
  readonly error?: unknown;
}

function directKill(
  child: ProcessTreeChild,
  signal: NodeJS.Signals,
  error?: unknown,
  taskkillStatus?: number | null,
): KillProcessTreeResult {
  try {
    return {
      terminated: child.kill(signal),
      usedFallback: true,
      ...(taskkillStatus !== undefined ? { taskkillStatus } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  } catch (fallbackError) {
    return {
      terminated: false,
      usedFallback: true,
      ...(taskkillStatus !== undefined ? { taskkillStatus } : {}),
      error: fallbackError,
    };
  }
}

export function killProcessTree(
  child: ProcessTreeChild,
  options: KillProcessTreeOptions,
): KillProcessTreeResult {
  const platform = options.platform ?? process.platform;
  const signal = options.signal ?? (options.graceful === false ? "SIGKILL" : "SIGTERM");
  const pid = child.pid;

  if (platform === "win32" && pid !== undefined) {
    const environment = options.environment ?? process.env;
    const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT ?? "C:\\Windows";
    const taskkill = NodePath.win32.join(systemRoot, "System32", "taskkill.exe");
    try {
      const spawnTaskkill =
        options.spawnTaskkill ??
        ((
          file: string,
          args: ReadonlyArray<string>,
          spawnOptions: { readonly stdio: "ignore"; readonly timeout: number },
        ) => spawnSync(file, [...args], spawnOptions));
      const result = spawnTaskkill(taskkill, ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 2_000,
      });
      if (!result.error && result.status === 0) {
        return { terminated: true, usedFallback: false, taskkillStatus: result.status };
      }
      return directKill(child, signal, result.error, result.status);
    } catch (error) {
      return directKill(child, signal, error);
    }
  }

  if (platform !== "win32" && options.isGroupLeader && pid !== undefined) {
    try {
      (options.killPid ?? process.kill)(-pid, signal);
      return { terminated: true, usedFallback: false };
    } catch (error) {
      return directKill(child, signal, error);
    }
  }

  return directKill(child, signal);
}
