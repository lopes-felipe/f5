import * as FS from "node:fs/promises";
import * as Path from "node:path";

import {
  type ActiveProfile,
  ClaudeSettings,
  type DiskSpaceLevel,
  type DiskSpaceStatus,
  type DiskSpaceVolume,
  type DiskSpaceVolumeRole,
  ProviderDriverKind,
  type ServerSettings,
} from "@t3tools/contracts";
import { formatByteSize } from "@t3tools/shared/byteSize";
import { describeDiskSpaceRoles } from "@t3tools/shared/diskSpace";
import { Effect, Path as EffectPath, Schema } from "effect";

import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import { resolveClaudeConfigDir } from "../provider/Layers/ClaudeAdapter.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { buildAccountExecutionEnvironment } from "../providerProcessEnv.ts";
import { resolveCodexLaunchHomes } from "./codexMarketplaceStaging.ts";

/**
 * Free disk space on the volumes F5 writes to (its userdata and worktrees)
 * and the provider homes it launches CLIs against. When the disk filled up
 * during a turn, the Claude CLI silently dropped the last transcript entries
 * and the thread could not be resumed. Below {@link LOW_DISK_SPACE_BYTES}
 * the UI warns; below {@link CRITICAL_DISK_SPACE_BYTES} new turns are held
 * until space is freed, so a turn never starts on a disk that cannot hold it.
 */
export const LOW_DISK_SPACE_BYTES = 10 * 1024 ** 3;
export const CRITICAL_DISK_SPACE_BYTES = 2 * 1024 ** 3;

export interface WatchedPath {
  readonly path: string;
  readonly role: DiskSpaceVolumeRole;
}

export interface VolumeStat {
  /** Identifies the volume; paths with the same device share free space. */
  readonly device: number;
  readonly freeBytes: number;
  readonly totalBytes: number;
}

export type VolumeStatReader = (path: string) => Promise<VolumeStat>;

const ClaudeSettingsFromUnknown = Schema.decodeUnknownOption(ClaudeSettings);
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

/** An invalid instance environment cannot launch the CLI either; fall back to the inherited one. */
function providerEnvironmentOrBase(
  input: Parameters<typeof buildAccountExecutionEnvironment>[0],
): NodeJS.ProcessEnv {
  try {
    return buildAccountExecutionEnvironment(input);
  } catch {
    return input.baseEnv;
  }
}

/** Settings that cannot resolve a Codex home cannot launch Codex either. */
function codexHomesOrNone(input: Parameters<typeof resolveCodexLaunchHomes>[0]) {
  try {
    return resolveCodexLaunchHomes(input);
  } catch {
    return [];
  }
}

/**
 * Claude config dirs (where the CLI writes session transcripts) of every
 * enabled Claude instance, resolved the way a launch resolves them.
 */
export const resolveClaudeLaunchConfigDirs = Effect.fn("resolveClaudeLaunchConfigDirs")(
  function* (input: {
    readonly settings: ServerSettings;
    readonly profile: ActiveProfile | undefined;
    readonly stateDir: string;
    readonly baseEnv?: NodeJS.ProcessEnv;
  }): Effect.fn.Return<ReadonlyArray<string>, never, EffectPath.Path> {
    const baseEnv = input.baseEnv ?? process.env;
    const dirs = new Set<string>();
    for (const entry of Object.values(deriveProviderInstanceConfigMap(input.settings))) {
      if (entry.driver !== CLAUDE_DRIVER) continue;
      const decoded = ClaudeSettingsFromUnknown(entry.config ?? {});
      if (decoded._tag === "None" || !decoded.value.enabled) continue;
      const environment = providerEnvironmentOrBase({
        purpose: "provider",
        profile: input.profile,
        stateDir: input.stateDir,
        baseEnv,
        instance: entry.environment,
      });
      const claudeEnvironment = yield* makeClaudeEnvironment(decoded.value, environment);
      dirs.add(resolveClaudeConfigDir(claudeEnvironment));
    }
    return [...dirs];
  },
);

/** Every path whose volume a turn writes to: userdata, worktrees and provider homes. */
export const resolveWatchedPaths = Effect.fn("resolveWatchedPaths")(function* (input: {
  readonly stateDir: string;
  readonly worktreesDir: string;
  readonly settings: ServerSettings | null;
  readonly profile: ActiveProfile | undefined;
}): Effect.fn.Return<ReadonlyArray<WatchedPath>, never, EffectPath.Path> {
  const watched: WatchedPath[] = [
    { path: input.stateDir, role: "userdata" },
    { path: input.worktreesDir, role: "userdata" },
  ];
  if (input.settings === null) return watched;
  for (const path of yield* resolveClaudeLaunchConfigDirs({
    settings: input.settings,
    profile: input.profile,
    stateDir: input.stateDir,
  })) {
    watched.push({ path, role: "claudeHome" });
  }
  for (const path of codexHomesOrNone({
    settings: input.settings,
    profile: input.profile,
    stateDir: input.stateDir,
  })) {
    watched.push({ path, role: "codexHome" });
  }
  return watched;
});

/** The path itself, or its nearest existing ancestor: a home may not exist yet. */
async function nearestExistingPath(target: string): Promise<string> {
  let current = Path.resolve(target);
  for (;;) {
    if ((await FS.stat(current).catch(() => null)) !== null) return current;
    const parent = Path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

export const readVolumeStat: VolumeStatReader = async (target) => {
  const existing = await nearestExistingPath(target);
  const [stat, volume] = await Promise.all([FS.stat(existing), FS.statfs(existing)]);
  return {
    device: stat.dev,
    freeBytes: volume.bavail * volume.bsize,
    totalBytes: volume.blocks * volume.bsize,
  };
};

export function diskSpaceLevel(freeBytes: number): DiskSpaceLevel {
  if (freeBytes < CRITICAL_DISK_SPACE_BYTES) return "critical";
  if (freeBytes < LOW_DISK_SPACE_BYTES) return "low";
  return "ok";
}

const LEVEL_RANK: Record<DiskSpaceLevel, number> = { ok: 0, low: 1, critical: 2 };

export function worstDiskSpaceLevel(levels: ReadonlyArray<DiskSpaceLevel>): DiskSpaceLevel {
  return levels.reduce<DiskSpaceLevel>(
    (worst, level) => (LEVEL_RANK[level] > LEVEL_RANK[worst] ? level : worst),
    "ok",
  );
}

const ROLE_ORDER: ReadonlyArray<DiskSpaceVolumeRole> = ["userdata", "claudeHome", "codexHome"];

/**
 * One entry per volume, labelled with the first watched path on it. A path
 * that cannot be inspected is skipped: it must not hide the volumes that can.
 */
export async function inspectVolumes(input: {
  readonly watched: ReadonlyArray<WatchedPath>;
  readonly readStat?: VolumeStatReader;
}): Promise<ReadonlyArray<DiskSpaceVolume>> {
  const readStat = input.readStat ?? readVolumeStat;
  const byDevice = new Map<
    number,
    { path: string; roles: Set<DiskSpaceVolumeRole>; freeBytes: number; totalBytes: number }
  >();
  const stats = await Promise.all(
    input.watched.map((entry) =>
      readStat(entry.path).then(
        (stat) => ({ entry, stat }),
        () => null,
      ),
    ),
  );
  for (const result of stats) {
    if (result === null) continue;
    const existing = byDevice.get(result.stat.device);
    if (existing) {
      existing.roles.add(result.entry.role);
      continue;
    }
    byDevice.set(result.stat.device, {
      path: result.entry.path,
      roles: new Set([result.entry.role]),
      freeBytes: Math.max(0, Math.floor(result.stat.freeBytes)),
      totalBytes: Math.max(0, Math.floor(result.stat.totalBytes)),
    });
  }
  return [...byDevice.values()].map((volume) => ({
    path: volume.path,
    roles: ROLE_ORDER.filter((role) => volume.roles.has(role)),
    freeBytes: volume.freeBytes,
    totalBytes: volume.totalBytes,
    level: diskSpaceLevel(volume.freeBytes),
  }));
}

/**
 * Why new turns are held, or null when every watched volume has room. Names
 * the fullest critical volume and what F5 keeps on it.
 */
export function diskSpaceHoldDetail(status: DiskSpaceStatus): string | null {
  const critical = status.volumes
    .filter((volume) => volume.level === "critical")
    .toSorted((left, right) => left.freeBytes - right.freeBytes)[0];
  if (critical === undefined) return null;
  return (
    `Only ${formatByteSize(critical.freeBytes)} of disk space is free on the volume holding ` +
    `${describeDiskSpaceRoles(critical.roles)} (${critical.path}). New turns are held below ` +
    `${formatByteSize(status.criticalThresholdBytes)} so the agent cannot lose transcript ` +
    `entries. Free up space (Settings > Storage) and the turn will start.`
  );
}
