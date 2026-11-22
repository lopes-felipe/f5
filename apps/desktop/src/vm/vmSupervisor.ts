import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";
import { abortableDelay, acquireFileLock, LockHeld, type FileLockOptions } from "./fileLock";
import { ensureGuestImage, pruneGuestImages, type GuestImagePin } from "./guestImage";
import {
  buildLimaInstanceConfig,
  LIMA_DATA_DISK_NAME,
  LIMA_INSTANCE_NAME,
  serializeLimaInstanceConfig,
  VM_DEFAULT_DATA_DISK_GIB,
} from "./limaInstanceConfig";

/**
 * The host side of one Linux VM profile incarnation. Main runs it as the backend process,
 * inside the same macOS GUI-denial sandbox as host backends, so every Lima and ssh process
 * it starts inherits that sandbox.
 *
 * It prepares the VM (image, data disk, instance, boot, backend install), forwards the
 * profile's port to the guest on 127.0.0.1, and then runs `limactl shell … f5-guest launch`
 * on this process's own stdin and stdout. Those are main's private pipes: main writes the
 * boot line and frames to them, and this process never reads or writes them, so neither
 * passes through its memory or arguments. It logs to stderr only. Every other child gets
 * fresh stdio, so no Lima process (the daemonized hostagent included) holds the channel open.
 * Its exit is the backend's exit.
 */
export interface VmSupervisorConfig {
  readonly profileId: string;
  readonly incarnation: string;
  readonly port: number;
  readonly limactl: string;
  readonly limaHome: string;
  /** Main-owned metadata in the profile's state directory. */
  readonly vmDir: string;
  readonly imageCacheDir: string;
  readonly imagePin: GuestImagePin;
  readonly backend: { readonly archive: string; readonly sha256: string; readonly version: string };
  readonly cpus?: number;
  readonly memoryGiB?: number;
  readonly dataDiskGiB?: number;
  /** Where a refusal's message goes, for main's startup-recovery window. */
  readonly startupErrorPath: string;
}

export class VmSupervisorRefusal extends Error {
  override readonly name = "VmSupervisorRefusal";
}

/** Exit code main already treats as "startup refused; read the diagnostic". */
export const VM_REFUSED_EXIT_CODE = 78;

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface VmSupervisorDeps {
  /** Runs a command to completion. An aborted `signal` kills it. */
  run(
    command: string,
    args: ReadonlyArray<string>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RunResult>;
  spawn(
    command: string,
    args: ReadonlyArray<string>,
    stdio: ChildProcess.StdioOptions,
  ): ChildProcess.ChildProcess;
  ensureImage(pin: GuestImagePin, cacheDir: string, signal: AbortSignal): Promise<string>;
  log(message: string): void;
  /** Delay between readiness polls; tests shorten it. */
  readonly pollMs?: number;
}

interface InstanceRecord {
  readonly imageSha256: string;
}

const GUEST_TOOL = "/opt/f5/bin/f5-guest";
const MINUTE = 60_000;
/** `limactl stop`'s budget. Main's stop grace for VM profiles must exceed it. */
export const VM_STOP_TIMEOUT_MS = MINUTE;
/** How long a first boot may take to load its policy and mount the data disk. */
export const GUEST_READY_WAIT_MS = 90_000;
/** Not-ready reasons a booting guest reports until its units finish; anything else refuses at once. */
const TRANSIENT_GUEST_REASONS = new Set([
  "the egress policy is not loaded",
  "the data disk is not attached",
]);
/** How long a new incarnation waits for another one's start or stop of the same VM. */
export const INSTANCE_LOCK_WAIT_MS = 2 * MINUTE;

export class VmStopped extends Error {
  override readonly name = "VmStopped";
}

/**
 * One supervisor per VM at a time. Main never runs two incarnations of a profile at once,
 * but a supervisor it gave up on (killed or timed out mid-stop) can still be running
 * `limactl stop`; a new one waits for it instead of racing it.
 */
export async function acquireInstanceLock(
  path: string,
  signal: AbortSignal,
  options: FileLockOptions = {},
): Promise<() => void> {
  try {
    return await acquireFileLock(path, signal, { waitMs: INSTANCE_LOCK_WAIT_MS, ...options });
  } catch (error) {
    if (error instanceof LockHeld)
      throw new VmSupervisorRefusal(
        "Another start or stop of this VM is still running. Try again when it finishes.",
      );
    throw error;
  }
}

export function parseVmSupervisorConfig(raw: string | undefined): VmSupervisorConfig {
  if (!raw) throw new VmSupervisorRefusal("Missing VM supervisor configuration.");
  const config = JSON.parse(raw) as VmSupervisorConfig;
  const absolute = [config.limactl, config.limaHome, config.vmDir, config.imageCacheDir];
  if (
    !/^[0-9a-f]{32}$/.test(config.profileId) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(config.incarnation) ||
    !Number.isInteger(config.port) ||
    config.port < 1024 ||
    config.port > 65535 ||
    !absolute.every((path) => typeof path === "string" && Path.isAbsolute(path)) ||
    !Path.isAbsolute(config.backend?.archive ?? "") ||
    !/^[0-9a-f]{64}$/.test(config.backend?.sha256 ?? "") ||
    !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(config.backend?.version ?? "") ||
    !Path.isAbsolute(config.startupErrorPath ?? "")
  )
    throw new VmSupervisorRefusal("Invalid VM supervisor configuration.");
  return config;
}

export class VmSupervisor {
  constructor(
    private readonly config: VmSupervisorConfig,
    private readonly deps: VmSupervisorDeps,
    /** Main asked the profile to stop: abandon preparation and kill what it is running. */
    private readonly stopSignal: AbortSignal = new AbortController().signal,
  ) {}

  private throwIfStopped(): void {
    if (this.stopSignal.aborted) throw new VmStopped();
  }

  private async limactl(args: ReadonlyArray<string>, timeoutMs: number): Promise<RunResult> {
    this.throwIfStopped();
    const result = await this.deps.run(this.config.limactl, args, timeoutMs, this.stopSignal);
    this.throwIfStopped();
    return result;
  }

  private async limactlOk(args: ReadonlyArray<string>, timeoutMs: number, what: string) {
    const result = await this.limactl(args, timeoutMs);
    if (result.code !== 0)
      throw new VmSupervisorRefusal(
        `${what} failed: ${lastLine(result.stderr) || `exit ${result.code}`}. Lima logs: ${Path.join(this.config.limaHome, LIMA_INSTANCE_NAME)}`,
      );
    return result;
  }

  private guest(args: ReadonlyArray<string>, timeoutMs: number) {
    return this.limactl(
      ["shell", "--workdir", "/", LIMA_INSTANCE_NAME, "sudo", "-n", GUEST_TOOL, ...args],
      timeoutMs,
    );
  }

  /** Lima merges these into every instance; F5 never writes them, so their presence is foreign. */
  private refuseForeignLimaConfig(): void {
    for (const name of ["default.yaml", "override.yaml"])
      if (FS.existsSync(Path.join(this.config.limaHome, "_config", name)))
        throw new VmSupervisorRefusal(
          `Unexpected Lima configuration ${name} in ${this.config.limaHome}; F5 won't start this VM.`,
        );
  }

  private async instanceStatus(): Promise<string | null> {
    const result = await this.limactlOk(["list", "--json"], MINUTE, "Listing Lima instances");
    for (const line of result.stdout.split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as { name?: string; status?: string };
      if (entry.name === LIMA_INSTANCE_NAME) return entry.status ?? "Unknown";
    }
    return null;
  }

  private readInstanceRecord(): InstanceRecord | null {
    try {
      return JSON.parse(
        FS.readFileSync(Path.join(this.config.vmDir, "instance.json"), "utf8"),
      ) as InstanceRecord;
    } catch {
      return null;
    }
  }

  private async ensureDataDisk(): Promise<void> {
    if (FS.existsSync(Path.join(this.config.limaHome, "_disks", LIMA_DATA_DISK_NAME))) return;
    this.deps.log("Creating the data disk");
    await this.limactlOk(
      [
        "disk",
        "create",
        LIMA_DATA_DISK_NAME,
        "--size",
        `${this.config.dataDiskGiB ?? VM_DEFAULT_DATA_DISK_GIB}GiB`,
        "--format",
        "raw",
      ],
      MINUTE,
      "Creating the data disk",
    );
  }

  /** Boots the VM with the pinned image. Returns once the guest reports ready. */
  async prepare(): Promise<void> {
    const { config } = this;
    await FSP.mkdir(config.limaHome, { recursive: true, mode: 0o700 });
    await FSP.mkdir(config.vmDir, { recursive: true, mode: 0o700 });
    this.refuseForeignLimaConfig();

    this.deps.log("Checking the guest image");
    const imagePath = await this.deps.ensureImage(
      config.imagePin,
      config.imageCacheDir,
      this.stopSignal,
    );
    this.throwIfStopped();

    let status = await this.instanceStatus();
    const record = this.readInstanceRecord();
    if (status !== null && record?.imageSha256 !== config.imagePin.sha256) {
      // A new image replaces the root disk. The data disk lives outside the instance.
      this.deps.log("Replacing the guest root disk with the new image");
      if (status === "Running")
        await this.limactlOk(["stop", LIMA_INSTANCE_NAME], 5 * MINUTE, "Stopping the VM");
      await this.limactlOk(["delete", "--force", LIMA_INSTANCE_NAME], MINUTE, "Removing the VM");
      status = null;
    }

    await this.ensureDataDisk();
    if (status === null) {
      this.deps.log("Provisioning the VM");
      const yamlPath = Path.join(config.vmDir, "lima.yaml");
      await FSP.writeFile(
        yamlPath,
        serializeLimaInstanceConfig(
          buildLimaInstanceConfig({
            imagePath,
            imageSha256: config.imagePin.sha256,
            ...(config.cpus !== undefined ? { cpus: config.cpus } : {}),
            ...(config.memoryGiB !== undefined ? { memoryGiB: config.memoryGiB } : {}),
          }),
        ),
        { mode: 0o600 },
      );
      await this.limactlOk(
        ["create", "--tty=false", "--name", LIMA_INSTANCE_NAME, yamlPath],
        5 * MINUTE,
        "Creating the VM",
      );
      await FSP.writeFile(
        Path.join(config.vmDir, "instance.json"),
        JSON.stringify({ imageSha256: config.imagePin.sha256 } satisfies InstanceRecord) + "\n",
        { mode: 0o600 },
      );
      await pruneGuestImages(config.imageCacheDir, config.imagePin.sha256).catch(() => undefined);
      status = "Stopped";
    }
    if (status !== "Running") {
      this.deps.log("Booting the VM");
      await this.limactlOk(
        ["start", "--tty=false", "--timeout", "10m", LIMA_INSTANCE_NAME],
        11 * MINUTE,
        "Booting the VM",
      );
    }

    const ready = await this.guestStatus();
    if (!ready.backends.includes(config.backend.version)) await this.installBackend();
  }

  /**
   * The guest's readiness report. A booting guest may still be loading its egress policy or
   * mounting its data disk, so those two reasons are polled for a bounded time; any other
   * failure, or output that isn't a status report, refuses at once.
   */
  private async guestStatus(): Promise<{ backends: string[] }> {
    const deadline = Date.now() + GUEST_READY_WAIT_MS;
    for (;;) {
      const result = await this.guest(["status"], MINUTE);
      let status: { ready?: unknown; reason?: unknown; backends?: unknown } | null = null;
      try {
        status = JSON.parse(lastLine(result.stdout));
      } catch {
        /* Reported below. */
      }
      if (result.code === 0 && status?.ready === true)
        return {
          backends: Array.isArray(status.backends)
            ? status.backends.filter((value): value is string => typeof value === "string")
            : [],
        };
      const reason = typeof status?.reason === "string" ? status.reason : null;
      if (reason && TRANSIENT_GUEST_REASONS.has(reason) && Date.now() < deadline) {
        await abortableDelay(this.deps.pollMs ?? 3_000, this.stopSignal);
        continue;
      }
      throw new VmSupervisorRefusal(
        `The guest is not ready: ${reason ?? (lastLine(result.stderr) || `exit ${result.code}`)}. F5 won't run anything in it.`,
      );
    }
  }

  private async installBackend(): Promise<void> {
    const { backend, incarnation } = this.config;
    this.deps.log(`Installing F5 ${backend.version} in the VM`);
    const remote = `/tmp/f5-backend-${incarnation}.tar.gz`;
    await this.limactlOk(
      ["copy", backend.archive, `${LIMA_INSTANCE_NAME}:${remote}`],
      10 * MINUTE,
      "Copying the backend into the VM",
    );
    const result = await this.guest(
      ["install", backend.version, backend.sha256, remote],
      10 * MINUTE,
    );
    if (result.code !== 0)
      throw new VmSupervisorRefusal(
        `Installing the backend in the VM failed: ${lastLine(result.stderr) || `exit ${result.code}`}`,
      );
  }

  /**
   * The ssh ControlMaster main's forwards go through. It owns the profile's port forward
   * from the start; ExitOnForwardFailure turns an occupied port into an error, never a
   * different port.
   */
  startForwards(): ChildProcess.ChildProcess {
    const instanceDir = Path.join(this.config.limaHome, LIMA_INSTANCE_NAME);
    const port = String(this.config.port);
    return this.deps.spawn(
      "ssh",
      [
        "-F",
        Path.join(instanceDir, "ssh.config"),
        "-o",
        "ControlMaster=yes",
        "-o",
        `ControlPath=${Path.join(instanceDir, "ctl")}`,
        "-o",
        "ControlPersist=no",
        "-o",
        "ExitOnForwardFailure=yes",
        "-N",
        "-L",
        `127.0.0.1:${port}:127.0.0.1:${port}`,
        `lima-${LIMA_INSTANCE_NAME}`,
      ],
      ["ignore", "ignore", "inherit"],
    );
  }

  /** Main's pipes (this process's stdin and stdout) become the guest launcher's. */
  launchBackend(): ChildProcess.ChildProcess {
    const { incarnation, backend } = this.config;
    return this.deps.spawn(
      this.config.limactl,
      [
        "shell",
        "--workdir",
        "/",
        LIMA_INSTANCE_NAME,
        "sudo",
        "-n",
        GUEST_TOOL,
        "launch",
        incarnation,
        backend.version,
      ],
      ["inherit", "inherit", "inherit"],
    );
  }

  /**
   * Shuts the VM down, keeping its disks. Deliberately not tied to the stop signal: it runs
   * because main asked to stop. Harmless when the instance is already stopped or absent.
   */
  async stopVm(): Promise<void> {
    this.deps.log("Shutting down the VM");
    await this.deps
      .run(this.config.limactl, ["stop", LIMA_INSTANCE_NAME], VM_STOP_TIMEOUT_MS)
      .catch(() => undefined);
  }
}

const lastLine = (text: string) => text.trim().split("\n").at(-1)?.trim() ?? "";

/**
 * Resolves once with the child's exit code. Call it right after spawning: it also covers a
 * child that already exited (by code or by signal) and one that failed to spawn.
 */
export function waitForExit(child: ChildProcess.ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    if (child.signalCode !== null) return resolve(1);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.once("error", () => resolve(1));
  });
}

/**
 * Runs one incarnation. Resolves with the exit code for this process: the guest backend's,
 * 0 after a stop, or VM_REFUSED_EXIT_CODE after writing the refusal for main.
 *
 * `stopSignal` is main asking the profile to stop. Preparation is abandoned and whatever it
 * is running is killed; a running backend's channel closes, which stops the guest scope.
 * Then the VM shuts down, keeping its disks, before this process exits, so main counts the
 * profile against the VM cap until the VM is down. A refused start shuts the VM down too:
 * nothing would own it. Only a backend crash leaves the VM running, for the restart.
 */
export async function runVmSupervisor(
  config: VmSupervisorConfig,
  deps: VmSupervisorDeps,
  stopSignal: AbortSignal,
): Promise<number> {
  const refuse = async (message: string) => {
    deps.log(message);
    await FSP.writeFile(config.startupErrorPath, JSON.stringify({ message }) + "\n").catch(
      () => undefined,
    );
    return VM_REFUSED_EXIT_CODE;
  };
  let release: () => void;
  try {
    await FSP.mkdir(config.limaHome, { recursive: true, mode: 0o700 });
    release = await acquireInstanceLock(
      Path.join(config.limaHome, "supervisor.lock"),
      stopSignal,
      deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {},
    );
  } catch (error) {
    // Another supervisor owns this VM: leave it alone.
    if (stopSignal.aborted) return 0;
    return refuse(error instanceof Error ? error.message : "The VM could not be locked.");
  }
  try {
    return await runLocked(new VmSupervisor(config, deps, stopSignal), deps, stopSignal, refuse);
  } finally {
    release();
  }
}

async function runLocked(
  supervisor: VmSupervisor,
  deps: VmSupervisorDeps,
  stopSignal: AbortSignal,
  refuse: (message: string) => Promise<number>,
): Promise<number> {
  try {
    await supervisor.prepare();
  } catch (error) {
    await supervisor.stopVm();
    if (stopSignal.aborted) return 0;
    return refuse(error instanceof Error ? error.message : "The VM could not start.");
  }

  // Exit tracking starts at spawn, so an early exit (or a failed spawn) is never missed.
  const forwards = supervisor.startForwards();
  const forwardsExit = waitForExit(forwards);
  const backend = supervisor.launchBackend();
  const backendExit = waitForExit(backend);
  const stop = () => {
    backend.kill("SIGTERM");
    forwards.kill("SIGTERM");
  };
  if (stopSignal.aborted) stop();
  else stopSignal.addEventListener("abort", stop, { once: true });
  // Losing the forward makes the backend unreachable; end the incarnation.
  void forwardsExit.then(() => backend.kill("SIGTERM"));
  const code = await backendExit;
  forwards.kill("SIGTERM");
  await forwardsExit;
  stopSignal.removeEventListener("abort", stop);
  if (stopSignal.aborted) {
    await supervisor.stopVm();
    return 0;
  }
  if (code === VM_REFUSED_EXIT_CODE) {
    await supervisor.stopVm();
    return refuse("The guest refused to start the backend.");
  }
  deps.log(`The backend exited (${code}); the VM keeps running for the restart.`);
  return code;
}

export function defaultVmSupervisorDeps(config: VmSupervisorConfig): VmSupervisorDeps {
  // A private HOME: Lima and ssh never read the user's ~/.ssh/config, keys or caches.
  const home = Path.join(config.limaHome, ".home");
  FS.mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: "C.UTF-8",
    LIMA_HOME: config.limaHome,
  };
  return {
    run: (command, args, timeoutMs, signal) =>
      new Promise((resolve) => {
        ChildProcess.execFile(
          command,
          [...args],
          {
            env,
            timeout: timeoutMs,
            maxBuffer: 16 * 1024 * 1024,
            ...(signal ? { signal } : {}),
          },
          (error, stdout, stderr) => {
            // A non-zero exit carries its code; a timeout or spawn failure doesn't.
            const exitCode = (error as { code?: unknown } | null)?.code;
            const code = !error ? 0 : typeof exitCode === "number" ? exitCode : 1;
            resolve({ code, stdout: String(stdout), stderr: String(stderr) });
          },
        );
      }),
    spawn: (command, args, stdio) => ChildProcess.spawn(command, [...args], { env, stdio }),
    ensureImage: (pin, cacheDir, signal) =>
      ensureGuestImage({
        pin,
        cacheDir,
        signal,
        onProgress: throttleProgress((received, total) =>
          console.error(
            `[vm] Downloading the guest image: ${Math.floor((received / total) * 100)}%`,
          ),
        ),
      }),
    log: (message) => console.error(`[vm] ${message}`),
  };
}

function throttleProgress(report: (received: number, total: number) => void) {
  let lastPercent = -1;
  return ({ receivedBytes, totalBytes }: { receivedBytes: number; totalBytes: number }) => {
    const percent = Math.floor((receivedBytes / totalBytes) * 10) * 10;
    if (percent === lastPercent) return;
    lastPercent = percent;
    report(receivedBytes, totalBytes);
  };
}
