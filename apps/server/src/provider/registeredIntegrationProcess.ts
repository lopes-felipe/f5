import {
  spawn,
  type ChildProcess,
  type SpawnOptions as NodeSpawnOptions,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { PassThrough, type Readable, type Writable } from "node:stream";
import type { ChromeProcessRegistration, ProviderIntegrationKind } from "@t3tools/contracts";

export interface IntegrationProcessIdentity {
  readonly profileId: string;
  readonly backendIncarnation: string;
  readonly threadId: string;
  readonly sessionGeneration: string;
  readonly integration: ProviderIntegrationKind;
}
export type RegisterIntegrationProcess = (registration: ChromeProcessRegistration) => Promise<void>;

/** The subset of a spawned child the Claude SDK (and the integration proxy) need. */
export interface RegisteredProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  readonly launchToken: string;
  /** Resolves once desktop main accepted the registration and stdio started flowing. */
  readonly registered: Promise<void>;
  kill(signal: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  off(event: "error", listener: (error: Error) => void): void;
}

const killGroup = (child: ChildProcess, signal: NodeJS.Signals): boolean => {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return child.kill(signal);
  }
};

/**
 * Spawns an integration child in its own process group and registers
 * `{profile, incarnation, thread, generation, launchToken, pid, pgid, startTime}` with
 * desktop main before any stdio flows. A failed registration aborts the spawn: the
 * group is killed and stdout ends without a byte having been exchanged. No GUI
 * permissions are granted; the backend sandbox is unchanged.
 */
export function spawnRegisteredProcess(input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly identity: IntegrationProcessIdentity;
  readonly register: RegisterIntegrationProcess;
  readonly exited?: (launchToken: string) => void;
  readonly stderr?: (data: string) => void;
  readonly signal?: AbortSignal;
  readonly spawnImpl?: (
    command: string,
    args: ReadonlyArray<string>,
    options: NodeSpawnOptions,
  ) => ChildProcess;
}): RegisteredProcess {
  const launchToken = randomUUID();
  const startTime = Date.now();
  const child = (input.spawnImpl ?? spawn)(input.command, [...input.args], {
    ...(input.cwd ? { cwd: input.cwd } : {}),
    env: input.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const endStdout = () => {
    if (!stdout.writableEnded) stdout.end();
  };
  // A write that lands after the group was killed raises EPIPE on the real pipe; `pipe`
  // adds no listener there, and an unhandled stream error would crash the server.
  child.stdin?.on("error", () => undefined);
  child.stdout?.on("error", endStdout);
  child.stderr?.on("error", () => undefined);
  child.stderr?.on("data", (data: Buffer) => input.stderr?.(data.toString()));
  /** `process.kill(-pgid)` doesn't set `ChildProcess.killed`; track the request here. */
  let killRequested = false;
  child.once("exit", () => {
    input.exited?.(launchToken);
    // A descendant holding the pipe must not keep stdout open after the child exited.
    setTimeout(endStdout, 1_000).unref();
  });
  // `exit` can precede the last stdout bytes; end once the child's stdio closed.
  child.once("close", endStdout);
  child.once("error", () => {
    if (!stdout.writableEnded) stdout.end();
  });
  const registered =
    child.pid === undefined
      ? Promise.reject(new Error("The integration process did not start."))
      : input.register({
          ...input.identity,
          launchToken,
          pid: child.pid,
          pgid: child.pid,
          startTime,
        });
  const flowing = registered.then(
    () => {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("The integration process exited.");
      if (child.stdin) stdin.pipe(child.stdin);
      child.stdout?.pipe(stdout);
    },
    (error: unknown) => {
      killGroup(child, "SIGKILL");
      if (!stdout.writableEnded) stdout.end();
      throw error;
    },
  );
  flowing.catch(() => undefined);
  input.signal?.addEventListener("abort", () => killGroup(child, "SIGTERM"), { once: true });
  return {
    stdin,
    stdout,
    launchToken,
    registered: flowing,
    get killed() {
      return killRequested || child.killed;
    },
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    kill: (signal) => {
      const sent = killGroup(child, signal);
      if (sent) killRequested = true;
      return sent;
    },
    on: (event: "exit" | "error", listener: (...args: any[]) => void) => {
      child.on(event, listener);
    },
    once: (event: "exit" | "error", listener: (...args: any[]) => void) => {
      child.once(event, listener);
    },
    off: (event: "exit" | "error", listener: (...args: any[]) => void) => {
      child.off(event, listener);
    },
  } as RegisteredProcess;
}
