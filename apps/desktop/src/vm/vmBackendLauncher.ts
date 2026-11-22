import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";
import { parseRelease, selectArtifact } from "@t3tools/shared/cliRelease";
import imageLock from "../../vm-guest/image.lock.json";
import { isolatedBackendCommand } from "../backendComputerIsolation";
import { streamBackendChannel } from "../computer/BackendChannel";
import type { ProfileBackendLauncher } from "../profileBackendLauncher";
import { parseGuestImagePin, type GuestImagePin } from "./guestImage";
import { guestImageCacheDir, limaHomeFor } from "./limaInstanceConfig";
import type { VmSupervisorConfig } from "./vmSupervisor";

/**
 * Linux VM profiles are behind a hidden flag until the preview ships: without
 * `F5_EXPERIMENTAL_LINUX_VM=1` there is no VM launcher, so VM profiles stay refused.
 */
export const LINUX_VM_EXPERIMENT_ENV = "F5_EXPERIMENTAL_LINUX_VM";

/** First start downloads the image, provisions the VM and installs the backend. */
export const VM_READINESS_TIMEOUT_MS = 15 * 60_000;

/** Running VMs, within the overall backend cap. Each defaults to 4 GiB of guest memory. */
export const MAX_RUNNING_VMS = 2;

export interface VmLaunchAssets {
  readonly limactl: string;
  readonly backend: { readonly archive: string; readonly sha256: string; readonly version: string };
  readonly imagePin: GuestImagePin;
}

export type VmLaunchAssetsResolution =
  | { readonly ok: true; readonly assets: VmLaunchAssets }
  | { readonly ok: false; readonly reason: string };

/**
 * The bundled Lima, linux-arm64 backend archive and pinned guest image. Development builds
 * may point at their own with F5_VM_LIMACTL, F5_VM_BACKEND_ARCHIVE (the archive's manifest
 * JSON sits next to it, as `dist:cli:archive` writes it) and F5_VM_IMAGE_URL,
 * F5_VM_IMAGE_SHA256 and F5_VM_IMAGE_SIZE.
 */
export function resolveVmLaunchAssets(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly resourcesPath: string;
  readonly lock?: unknown;
  readonly exists?: (path: string) => boolean;
  readonly readFile?: (path: string) => string;
}): VmLaunchAssetsResolution {
  const exists = input.exists ?? FS.existsSync;
  const readFile = input.readFile ?? ((path: string) => FS.readFileSync(path, "utf8"));
  const { env } = input;
  if (env[LINUX_VM_EXPERIMENT_ENV] !== "1")
    return { ok: false, reason: "Linux VM profiles are not enabled in this build." };
  if (input.platform !== "darwin" || input.arch !== "arm64")
    return { ok: false, reason: "Linux VM profiles need a Mac with Apple silicon." };

  const limactl =
    env.F5_VM_LIMACTL || Path.join(input.resourcesPath, "native", "lima", "bin", "limactl");
  if (!Path.isAbsolute(limactl) || !exists(limactl))
    return { ok: false, reason: `Lima is missing (${limactl}).` };

  const vmDir = Path.join(input.resourcesPath, "vm");
  const archive = env.F5_VM_BACKEND_ARCHIVE || findBundledArchive(vmDir, exists);
  if (!archive || !Path.isAbsolute(archive) || !exists(archive))
    return { ok: false, reason: "The linux-arm64 backend archive is missing." };
  let backend: VmLaunchAssets["backend"];
  try {
    const release = parseRelease(JSON.parse(readFile(archive.replace(/\.tar\.gz$/, ".json"))));
    const artifact = selectArtifact(release, "linux-arm64");
    if (Path.basename(new URL(artifact.url).pathname) !== Path.basename(archive))
      throw new Error("The manifest names a different archive.");
    backend = { archive, sha256: artifact.sha256, version: release.version };
  } catch (error) {
    return {
      ok: false,
      reason: `The linux-arm64 backend manifest is invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let imagePin: GuestImagePin | null;
  try {
    imagePin = env.F5_VM_IMAGE_URL
      ? parseGuestImagePin(
          {
            image: {
              url: env.F5_VM_IMAGE_URL,
              sha256: env.F5_VM_IMAGE_SHA256,
              size: Number(env.F5_VM_IMAGE_SIZE),
            },
          },
          { allowAnyHttpsUrl: true },
        )
      : parseGuestImagePin(input.lock ?? imageLock);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!imagePin) return { ok: false, reason: "This build has no pinned guest image." };
  return { ok: true, assets: { limactl, backend, imagePin } };
}

function findBundledArchive(vmDir: string, exists: (path: string) => boolean): string | null {
  if (!exists(vmDir)) return null;
  const archives = FS.readdirSync(vmDir).filter((name) =>
    /^f5-[0-9A-Za-z.+-]+-linux-arm64\.tar\.gz$/.test(name),
  );
  return archives.length === 1 ? Path.join(vmDir, archives[0]!) : null;
}

type Spawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: ChildProcess.SpawnOptions,
) => ChildProcess.ChildProcess;

/**
 * Linux VM profiles. The process main supervises is the VM supervisor (see vmSupervisor.ts),
 * an Electron-as-Node process inside the same GUI-denial sandbox as host backends. Its stdin
 * and stdout are main's channel to the guest backend: main writes the boot line, then frames.
 * Its environment carries no inherited secrets; the auth token travels only in the boot line.
 */
export function vmBackendLauncher(options: {
  readonly platform: NodeJS.Platform;
  readonly executable: string;
  readonly supervisorEntry: string;
  readonly stateDir: string;
  readonly assets: VmLaunchAssets;
  readonly startupErrorPath: (profileId: string) => string;
  readonly spawn?: Spawn;
}): ProfileBackendLauncher {
  const spawn = options.spawn ?? ChildProcess.spawn;
  return {
    environment: "linux-vm",
    readinessTimeoutMs: VM_READINESS_TIMEOUT_MS,
    launch: (request) => {
      const config: VmSupervisorConfig = {
        profileId: request.profileId,
        incarnation: request.incarnation,
        port: request.port,
        limactl: options.assets.limactl,
        limaHome: limaHomeFor(options.stateDir, request.profileId),
        vmDir: Path.join(request.profileStateDir, "vm"),
        imageCacheDir: guestImageCacheDir(options.stateDir),
        imagePin: options.assets.imagePin,
        backend: options.assets.backend,
        startupErrorPath: options.startupErrorPath(request.profileId),
      };
      const isolated = isolatedBackendCommand(
        options.platform,
        options.executable,
        options.supervisorEntry,
        request.nodeArgs,
      );
      const child = spawn(isolated.executable, isolated.args, {
        cwd: request.cwd,
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: request.env.HOME ?? "",
          TMPDIR: request.env.TMPDIR ?? "/tmp",
          LANG: "C.UTF-8",
          ELECTRON_RUN_AS_NODE: "1",
          F5_VM_SUPERVISOR_CONFIG: JSON.stringify(config),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      // Buffered until the guest launcher reads it, after the VM is ready.
      child.stdin!.write(
        JSON.stringify({
          port: request.port,
          authToken: request.authToken,
          profileId: request.profileId,
        }) + "\n",
      );
      return {
        process: child,
        channel: streamBackendChannel({ input: child.stdout!, output: child.stdin! }),
        stdoutIsLog: false,
      };
    },
  };
}
