import * as FS from "node:fs/promises";
import * as Path from "node:path";

import {
  type ActiveProfile,
  CodexSettings,
  ProviderDriverKind,
  type ServerSettings,
} from "@t3tools/contracts";
import { Schema } from "effect";

import { resolveCodexInstanceHomePaths } from "../provider/Drivers/CodexHomeLayout.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { buildAccountExecutionEnvironment } from "../providerProcessEnv.ts";
import { recursiveSize } from "./diskUsage.ts";
import { removeTreeIfSafe, type StoragePathWarningInput } from "./storagePathSafety.ts";

/**
 * Codex upgrades a configured Git marketplace by cloning it into
 * `<CODEX_HOME>/.tmp/marketplaces/.staging/marketplace-upgrade-*`, then swaps
 * it in and parks the previous root in `.tmp/marketplaces/marketplace-backup-*`.
 * Both are temp dirs that Codex removes only when the upgrade runs to the end
 * in a live process. When F5 stops an app-server mid-upgrade (or Git outlives
 * it and finishes the clone), the full clone stays behind; at a few hundred
 * MB each they filled the disk. Nothing reads them afterwards, so anything
 * past the age guard is garbage.
 */
export const CODEX_MARKETPLACE_LEFTOVER_MIN_AGE_MS = 2 * 60 * 60 * 1_000;

const STAGING_PREFIX = "marketplace-upgrade-";
const BACKUP_PREFIX = "marketplace-backup-";

export interface CodexMarketplaceLeftover {
  /** The Codex home the leftover belongs to. */
  readonly home: string;
  /** `<home>/.tmp/marketplaces`: the only root a removal may touch. */
  readonly root: string;
  readonly path: string;
  readonly kind: "staging" | "backup";
  readonly mtimeMs: number;
}

const CodexSettingsFromUnknown = Schema.decodeUnknownOption(CodexSettings);
const CODEX_DRIVER = ProviderDriverKind.make("codex");

/**
 * Codex homes F5 launches Codex processes against, from the current settings:
 * every configured Codex instance's `homePath` (or the `CODEX_HOME` its
 * process environment inherits, or `~/.codex`), plus any shadow home.
 */
export function resolveCodexLaunchHomes(input: {
  readonly settings: ServerSettings;
  readonly profile: ActiveProfile | undefined;
  readonly stateDir: string;
  readonly baseEnv?: NodeJS.ProcessEnv;
}): ReadonlyArray<string> {
  const homes = new Set<string>();
  const managed = input.profile !== undefined && !input.profile.isDefault;
  for (const entry of Object.values(deriveProviderInstanceConfigMap(input.settings))) {
    if (entry.driver !== CODEX_DRIVER) continue;
    const decoded = CodexSettingsFromUnknown(entry.config ?? {});
    if (decoded._tag === "None") continue;
    let inheritedCodexHome: string | undefined;
    try {
      inheritedCodexHome = buildAccountExecutionEnvironment({
        purpose: "provider",
        profile: input.profile,
        stateDir: input.stateDir,
        baseEnv: input.baseEnv ?? process.env,
        instance: entry.environment,
      }).CODEX_HOME;
    } catch {
      // An invalid instance environment cannot launch Codex either; fall back
      // to the inherited value so its home is still swept.
      inheritedCodexHome = (input.baseEnv ?? process.env).CODEX_HOME;
    }
    for (const home of resolveCodexInstanceHomePaths({
      config: decoded.value,
      managed,
      inheritedCodexHome,
    })) {
      homes.add(home);
    }
  }
  return [...homes];
}

async function listPrefixedDirectories(
  directory: string,
  prefix: string,
): Promise<Array<{ readonly path: string; readonly mtimeMs: number }>> {
  const entries = await FS.readdir(directory, { withFileTypes: true }).catch(() => []);
  const result: Array<{ readonly path: string; readonly mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(prefix) || !entry.isDirectory()) continue;
    const target = Path.join(directory, entry.name);
    const stat = await FS.lstat(target).catch(() => null);
    if (stat?.isDirectory()) result.push({ path: target, mtimeMs: stat.mtimeMs });
  }
  return result;
}

/**
 * Leftover marketplace upgrade clones and backups older than the age guard,
 * which keeps an upgrade that is still running out of reach. Homes that
 * resolve to the same directory (a shadow home links `.tmp` to its shared
 * home) are scanned once.
 */
export async function listCodexMarketplaceLeftovers(input: {
  readonly homes: ReadonlyArray<string>;
  readonly nowMs: number;
  readonly minAgeMs?: number;
}): Promise<ReadonlyArray<CodexMarketplaceLeftover>> {
  const cutoff = input.nowMs - (input.minAgeMs ?? CODEX_MARKETPLACE_LEFTOVER_MIN_AGE_MS);
  const seenRoots = new Set<string>();
  const leftovers: CodexMarketplaceLeftover[] = [];
  for (const home of input.homes) {
    const root = Path.join(home, ".tmp", "marketplaces");
    const realRoot = await FS.realpath(root).catch(() => null);
    if (realRoot === null || seenRoots.has(realRoot)) continue;
    seenRoots.add(realRoot);
    const candidates = [
      ...(await listPrefixedDirectories(Path.join(root, ".staging"), STAGING_PREFIX)).map(
        (entry) => ({ ...entry, kind: "staging" as const }),
      ),
      ...(await listPrefixedDirectories(root, BACKUP_PREFIX)).map((entry) => ({
        ...entry,
        kind: "backup" as const,
      })),
    ];
    for (const candidate of candidates) {
      if (candidate.mtimeMs < cutoff) leftovers.push({ ...candidate, home, root });
    }
  }
  return leftovers;
}

export async function codexMarketplaceLeftoverBytes(
  leftover: CodexMarketplaceLeftover,
): Promise<number> {
  return (await recursiveSize(leftover.path)).bytes;
}

/**
 * Remove one leftover, refusing anything outside its marketplaces root or
 * reached through a symlink. Reports the bytes measured right before removal.
 */
export async function removeCodexMarketplaceLeftover(
  leftover: CodexMarketplaceLeftover,
): Promise<{ readonly reclaimedBytes: number; readonly warning?: StoragePathWarningInput }> {
  const bytes = await codexMarketplaceLeftoverBytes(leftover);
  const result = await removeTreeIfSafe({ path: leftover.path, allowedRoot: leftover.root });
  return result.warning
    ? { reclaimedBytes: 0, warning: result.warning }
    : { reclaimedBytes: result.reclaimedBytes > 0 ? bytes : 0 };
}
