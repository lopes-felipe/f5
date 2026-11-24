import * as ChildProcess from "node:child_process";
import type { ProfileExecutionEnvironment, ProfileRecord } from "@t3tools/contracts";
import { profileExecutionEnvironment } from "@t3tools/shared/profileExecution";
import { isolatedBackendCommand } from "./backendComputerIsolation";
import { childProcessBackendChannel, type BackendChannel } from "./computer/BackendChannel";
import { BACKEND_READINESS_TIMEOUT_MS } from "./profileRuntime";

export interface BackendLaunchRequest {
  /** Server entry script on the host. */
  readonly entry: string;
  readonly nodeArgs: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly incarnation: string;
  readonly profileId: string;
  /** The profile's host state directory. */
  readonly profileStateDir: string;
  /** The loopback port main reserved; the backend must answer on host 127.0.0.1 here. */
  readonly port: number;
  readonly authToken: string;
  /**
   * Called while startup makes progress that can legitimately outlast the readiness window
   * (a VM downloading its image or backend); main restarts the window each time.
   */
  readonly onStartupProgress?: () => void;
}

export interface BackendLaunch {
  /**
   * The host process main supervises: the backend itself, or the process that reaches a
   * guest backend. Its exit is the backend's exit for restart purposes.
   */
  readonly process: ChildProcess.ChildProcess;
  /** Main's private channel to this incarnation. */
  readonly channel: BackendChannel;
  /** False when stdout carries the channel and must not be read as log output. */
  readonly stdoutIsLog: boolean;
  /**
   * Resolves once the profile's port reaches this backend. Until then main sends the port
   * no authenticated request: another local process could be listening on it. Absent when
   * the backend binds the port itself.
   */
  readonly reachable?: Promise<void>;
}

/** Starts one backend incarnation for a profile in its execution environment. */
export interface ProfileBackendLauncher {
  readonly environment: ProfileExecutionEnvironment;
  /**
   * How long a new incarnation may take to answer readiness before recovery is offered,
   * counted from launch or its latest startup progress.
   */
  readonly readinessTimeoutMs: number;
  /**
   * How long main lets a stopping backend process exit on its own before force-killing its
   * process tree. A VM supervisor shuts its VM down first and must not be killed mid-stop.
   */
  readonly stopGraceMs: number;
  launch(request: BackendLaunchRequest): BackendLaunch;
}

/** Host backends: SIGTERM, then the whole tree is force-killed after this long. */
export const HOST_BACKEND_STOP_GRACE_MS = 2_000;

type Spawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: ChildProcess.SpawnOptions,
) => ChildProcess.ChildProcess;

/**
 * Host profiles: Electron in Node mode, inside the macOS GUI-denial sandbox, with inherited
 * IPC as the computer channel.
 */
export function hostBackendLauncher(options: {
  readonly platform: NodeJS.Platform;
  readonly executable: string;
  readonly spawn?: Spawn;
}): ProfileBackendLauncher {
  const spawn = options.spawn ?? ChildProcess.spawn;
  return {
    environment: "host",
    readinessTimeoutMs: BACKEND_READINESS_TIMEOUT_MS,
    stopGraceMs: HOST_BACKEND_STOP_GRACE_MS,
    launch: (request) => {
      const isolated = isolatedBackendCommand(
        options.platform,
        options.executable,
        request.entry,
        request.nodeArgs,
      );
      const child = spawn(isolated.executable, isolated.args, {
        cwd: request.cwd,
        // In Electron main, process.execPath points to the Electron binary.
        // Run the child in Node mode so this backend process does not become a GUI app instance.
        env: {
          ...request.env,
          ELECTRON_RUN_AS_NODE: "1",
          F5_DESKTOP_COMPUTER_HOST: "ipc",
          F5_DESKTOP_BACKEND_INCARNATION: request.incarnation,
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      return { process: child, channel: childProcessBackendChannel(child), stdoutIsLog: true };
    },
  };
}

export type BackendLauncherResolution =
  | { readonly ok: true; readonly launcher: ProfileBackendLauncher }
  | { readonly ok: false; readonly message: string };

export const LINUX_VM_UNAVAILABLE_MESSAGE =
  "This profile runs in a Linux VM, which this version of F5 can't start. F5 never runs it on the host; open a host profile instead.";

/**
 * The launcher for a profile's recorded environment. There is no fallback: an environment
 * without a launcher is refused, so a VM profile can never start on the host.
 */
export function resolveProfileBackendLauncher(
  profile: Pick<ProfileRecord, "executionEnvironment">,
  launchers: Partial<Record<ProfileExecutionEnvironment, ProfileBackendLauncher>>,
): BackendLauncherResolution {
  const environment = profileExecutionEnvironment(profile);
  const launcher = launchers[environment];
  if (!launcher || launcher.environment !== environment)
    return {
      ok: false,
      message: environment === "linux-vm" ? LINUX_VM_UNAVAILABLE_MESSAGE : "No backend launcher.",
    };
  return { ok: true, launcher };
}

/**
 * The launcher for `profile`, or an error carrying the refusal. Opening a profile calls this
 * before it reserves a port, configures request auth or counts against the backend cap, so
 * a refused profile fails once, with its own reason.
 */
export function requireProfileBackendLauncher(
  profile: Pick<ProfileRecord, "executionEnvironment">,
  launchers: Partial<Record<ProfileExecutionEnvironment, ProfileBackendLauncher>>,
): ProfileBackendLauncher {
  const resolved = resolveProfileBackendLauncher(profile, launchers);
  if (!resolved.ok) throw new Error(resolved.message);
  return resolved.launcher;
}
