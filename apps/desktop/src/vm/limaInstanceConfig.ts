import * as Path from "node:path";

/**
 * Lima instance configuration for a Linux VM profile. F5 generates every instance from this
 * builder: there are no user templates, host provisioning scripts, home mounts, agent or X11
 * forwarding, proxy propagation or automatic port forwards. The output is JSON, which Lima
 * reads as YAML, so no value can change the document's structure.
 */

export const LIMA_INSTANCE_NAME = "f5";
export const LIMA_ADMIN_USER = "f5admin";
export const LIMA_DATA_DISK_NAME = "f5-data";
export const LIMA_MINIMUM_VERSION = "2.3.0";

export const VM_DEFAULT_CPUS = 2;
export const VM_DEFAULT_MEMORY_GIB = 4;
/** The replaceable root disk. All state lives on the data disk. */
export const VM_ROOT_DISK_GIB = 8;
/** Sparse: the host only pays for what the guest writes. */
export const VM_DEFAULT_DATA_DISK_GIB = 40;

export interface LimaMount {
  /** Canonical absolute host path; the guest sees it at the same path. */
  readonly location: string;
  readonly writable: boolean;
}

export interface LimaInstanceInput {
  /** Local, digest-verified guest image. */
  readonly imagePath: string;
  readonly imageSha256: string;
  readonly cpus?: number;
  readonly memoryGiB?: number;
  readonly mounts?: ReadonlyArray<LimaMount>;
}

export class LimaConfigError extends Error {
  override readonly name = "LimaConfigError";
}

const positiveInteger = (value: number, label: string, max: number) => {
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new LimaConfigError(`${label} must be an integer from 1 to ${max}.`);
  return value;
};

export function buildLimaInstanceConfig(input: LimaInstanceInput): Record<string, unknown> {
  if (!Path.isAbsolute(input.imagePath) || Path.normalize(input.imagePath) !== input.imagePath)
    throw new LimaConfigError("The guest image path must be absolute and normalized.");
  if (!/^[0-9a-f]{64}$/.test(input.imageSha256))
    throw new LimaConfigError("The guest image digest must be a SHA-256 hex string.");
  const mounts = (input.mounts ?? []).map((mount) => {
    if (
      !Path.isAbsolute(mount.location) ||
      Path.normalize(mount.location) !== mount.location ||
      mount.location === "/"
    )
      throw new LimaConfigError(`Invalid mount location: ${mount.location}`);
    return { location: mount.location, mountPoint: mount.location, writable: mount.writable };
  });
  return {
    minimumLimaVersion: LIMA_MINIMUM_VERSION,
    vmType: "vz",
    arch: "aarch64",
    cpus: positiveInteger(input.cpus ?? VM_DEFAULT_CPUS, "CPU count", 16),
    memory: `${positiveInteger(input.memoryGiB ?? VM_DEFAULT_MEMORY_GIB, "Memory", 64)}GiB`,
    disk: `${VM_ROOT_DISK_GIB}GiB`,
    images: [
      {
        location: input.imagePath,
        arch: "aarch64",
        digest: `sha256:${input.imageSha256}`,
      },
    ],
    // Lima formats the disk on first attach and mounts it at /mnt/lima-f5-data; the guest
    // tool binds it to /var/lib/f5 and refuses to run anything without it.
    additionalDisks: [{ name: LIMA_DATA_DISK_NAME, format: true, fsType: "ext4" }],
    mountType: "virtiofs",
    mounts,
    user: { name: LIMA_ADMIN_USER },
    ssh: {
      loadDotSSHPubKeys: false,
      forwardAgent: false,
      forwardX11: false,
      forwardX11Trusted: false,
    },
    containerd: { system: false, user: false },
    rosetta: { enabled: false, binfmt: false },
    video: { display: "none" },
    audio: { device: "none" },
    propagateProxyEnv: false,
    upgradePackages: false,
    // Main adds each forward it approves through the ssh ControlMaster; Lima forwards nothing.
    portForwards: [
      { guestIP: "0.0.0.0", guestPortRange: [1, 65535], proto: "any", ignore: true },
      { guestIP: "127.0.0.1", guestPortRange: [1, 65535], proto: "any", ignore: true },
    ],
  };
}

export function serializeLimaInstanceConfig(config: Record<string, unknown>): string {
  return JSON.stringify(config, null, 2) + "\n";
}

/**
 * The longest UNIX socket path Lima and ssh create under LIMA_HOME: ssh's ControlMaster
 * binds `<instance>/ssh.sock.<16 random characters>` before renaming it.
 */
export function longestLimaSocketPath(limaHome: string): string {
  return Path.join(limaHome, LIMA_INSTANCE_NAME, "ssh.sock.") + "x".repeat(16);
}

/** macOS `sun_path` is 104 bytes including the terminating NUL. */
export const MAX_UNIX_SOCKET_PATH_BYTES = 103;

/**
 * A profile's LIMA_HOME. It sits in the installation's state directory rather than the
 * profile's own, because the profile path is too long for Lima's sockets on typical home
 * directories. A path that is still too long is refused rather than shortened elsewhere.
 */
export function limaHomeFor(stateDir: string, profileId: string): string {
  if (!/^[0-9a-f]{32}$/.test(profileId)) throw new LimaConfigError("Invalid profile id.");
  const limaHome = Path.join(Path.resolve(stateDir), "vm", profileId.slice(0, 16));
  if (Buffer.byteLength(longestLimaSocketPath(limaHome)) > MAX_UNIX_SOCKET_PATH_BYTES)
    throw new LimaConfigError(
      `The F5 state directory path is too long for a Linux VM (${limaHome}). Use a shorter state directory.`,
    );
  return limaHome;
}

/** Installation-wide cache of digest-verified guest images, shared by every VM profile. */
export const guestImageCacheDir = (stateDir: string) =>
  Path.join(Path.resolve(stateDir), "vm", "images");
