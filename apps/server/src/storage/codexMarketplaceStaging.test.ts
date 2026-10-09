import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ServerSettings } from "@t3tools/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  CODEX_MARKETPLACE_LEFTOVER_MIN_AGE_MS,
  listCodexMarketplaceLeftovers,
  removeCodexMarketplaceLeftover,
  resolveCodexLaunchHomes,
} from "./codexMarketplaceStaging.ts";

const HOUR_MS = 60 * 60 * 1_000;
const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "f5-codex-staging-")));
  roots.push(dir);
  return dir;
}

/** A directory with one file, back-dated by `ageMs` (its own mtime, like Codex's temp dirs). */
async function makeDir(target: string, ageMs: number, contents = "x".repeat(1_000)) {
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "payload"), contents);
  const when = new Date(Date.now() - ageMs);
  await fs.utimes(target, when, when);
}

/** A Codex home with old and fresh upgrade clones and backups, plus things the sweep must ignore. */
async function makeCodexHome(home: string) {
  const marketplaces = path.join(home, ".tmp", "marketplaces");
  const staging = path.join(marketplaces, ".staging");
  const old = 3 * HOUR_MS;
  await makeDir(path.join(staging, "marketplace-upgrade-old"), old);
  await makeDir(path.join(staging, "marketplace-upgrade-fresh"), 10 * 60 * 1_000);
  await makeDir(path.join(marketplaces, "marketplace-backup-old"), old);
  await makeDir(path.join(marketplaces, "marketplace-backup-fresh"), 0);
  // The installed marketplace and unrelated entries are never touched.
  await makeDir(path.join(marketplaces, "example-marketplace"), old);
  await makeDir(path.join(staging, "other-old"), old);
  await fs.writeFile(path.join(staging, "marketplace-upgrade-file"), "not a dir");
  const outside = path.join(path.dirname(home), `${path.basename(home)}-outside`);
  await makeDir(outside, old);
  await fs.symlink(outside, path.join(staging, "marketplace-upgrade-link"));
  return { marketplaces, staging, outside };
}

describe("listCodexMarketplaceLeftovers", () => {
  it("lists only upgrade clones and backups past the age guard", async () => {
    const home = path.join(await tempDir(), "codex");
    const { marketplaces, staging } = await makeCodexHome(home);

    const leftovers = await listCodexMarketplaceLeftovers({ homes: [home], nowMs: Date.now() });

    expect(
      leftovers.map((entry) => [entry.kind, entry.path, entry.root, entry.home]).toSorted(),
    ).toEqual(
      [
        ["backup", path.join(marketplaces, "marketplace-backup-old"), marketplaces, home],
        ["staging", path.join(staging, "marketplace-upgrade-old"), marketplaces, home],
      ].toSorted(),
    );
  });

  it("scans homes that share a marketplaces directory once and skips missing homes", async () => {
    const dir = await tempDir();
    const shared = path.join(dir, "shared");
    await makeCodexHome(shared);
    const shadow = path.join(dir, "shadow");
    await fs.mkdir(shadow);
    await fs.symlink(path.join(shared, ".tmp"), path.join(shadow, ".tmp"));

    const leftovers = await listCodexMarketplaceLeftovers({
      homes: [shared, shadow, path.join(dir, "missing")],
      nowMs: Date.now(),
    });

    expect(leftovers).toHaveLength(2);
    expect(new Set(leftovers.map((entry) => entry.home))).toEqual(new Set([shared]));
  });

  it("keeps a backup that may be the only copy of an installed marketplace", async () => {
    const home = path.join(await tempDir(), "codex");
    const marketplaces = path.join(home, ".tmp", "marketplaces");
    const old = 3 * HOUR_MS;
    const metadata = (revision: string) =>
      JSON.stringify({
        source_type: "git",
        source: "https://example.com/marketplace.git",
        ref_name: null,
        sparse_paths: [],
        revision,
      });
    const writeRoot = async (root: string, revision: string, manifest: boolean) => {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, ".codex-marketplace-install.json"), metadata(revision));
      if (manifest) {
        await fs.mkdir(path.join(root, ".agents", "plugins"), { recursive: true });
        await fs.writeFile(path.join(root, ".agents", "plugins", "marketplace.json"), "{}");
      }
    };
    const backdate = async (target: string) => {
      const when = new Date(Date.now() - old);
      await fs.utimes(target, when, when);
    };
    // Rollback failed: the backup holds the previous root and nothing replaced it.
    const retained = path.join(marketplaces, "marketplace-backup-retained");
    await writeRoot(path.join(retained, "root"), "old", true);
    await backdate(retained);

    const listed = async () =>
      (await listCodexMarketplaceLeftovers({ homes: [home], nowMs: Date.now() })).map(
        (entry) => entry.path,
      );
    expect(await listed()).toEqual([]);

    // An installed root from the same source without a manifest is incomplete
    // (a half-deleted destination), so the backup is still the safe copy.
    const installed = path.join(marketplaces, "example-marketplace");
    await writeRoot(installed, "new", false);
    expect(await listed()).toEqual([]);

    // Once a complete install from the same source exists, the backup is garbage.
    await fs.mkdir(path.join(installed, ".agents", "plugins"), { recursive: true });
    await fs.writeFile(path.join(installed, ".agents", "plugins", "marketplace.json"), "{}");
    expect(await listed()).toEqual([retained]);
  });

  it("uses a 2-hour age guard by default", () => {
    expect(CODEX_MARKETPLACE_LEFTOVER_MIN_AGE_MS).toBe(2 * HOUR_MS);
  });
});

describe("removeCodexMarketplaceLeftover", () => {
  it("removes the directory and reports the bytes it held", async () => {
    const home = path.join(await tempDir(), "codex");
    const { outside } = await makeCodexHome(home);
    const [leftover] = (
      await listCodexMarketplaceLeftovers({ homes: [home], nowMs: Date.now() })
    ).filter((entry) => entry.kind === "staging");

    const result = await removeCodexMarketplaceLeftover(leftover!);

    expect(result.warning).toBeUndefined();
    expect(result.reclaimedBytes).toBeGreaterThanOrEqual(1_000);
    await expect(fs.lstat(leftover!.path)).rejects.toThrow();
    // The symlink target outside the home is untouched.
    await expect(fs.lstat(outside)).resolves.toBeDefined();
  });

  it("refuses a path outside the marketplaces root", async () => {
    const dir = await tempDir();
    const target = path.join(dir, "marketplace-upgrade-elsewhere");
    await makeDir(target, 3 * HOUR_MS);

    const result = await removeCodexMarketplaceLeftover({
      home: path.join(dir, "codex"),
      root: path.join(dir, "codex", ".tmp", "marketplaces"),
      path: target,
      kind: "staging",
      mtimeMs: 0,
    });

    expect(result.reclaimedBytes).toBe(0);
    expect(result.warning?.reason).toMatch(/outside/);
    await expect(fs.lstat(target)).resolves.toBeDefined();
  });
});

describe("resolveCodexLaunchHomes", () => {
  const stateDir = "/state/profile";
  const homedir = os.homedir();

  it("uses the inherited CODEX_HOME, then ~/.codex, when homePath is empty", () => {
    const settings = decodeSettings({});
    expect(
      resolveCodexLaunchHomes({
        settings,
        profile: undefined,
        stateDir,
        baseEnv: { CODEX_HOME: "/env/codex" },
      }),
    ).toEqual(["/env/codex"]);
    expect(
      resolveCodexLaunchHomes({ settings, profile: undefined, stateDir, baseEnv: {} }),
    ).toEqual([path.join(homedir, ".codex")]);
  });

  it("includes every Codex instance, its shadow home, and no other drivers", () => {
    const settings = decodeSettings({
      providers: { codex: { homePath: "~/work-codex", shadowHomePath: "/shadow/codex" } },
      providerInstances: {
        codex_personal: { driver: "codex", config: { homePath: "/personal/codex" } },
        claude_extra: { driver: "claudeAgent", config: { homePath: "/claude/home" } },
      },
    });
    expect(
      resolveCodexLaunchHomes({ settings, profile: undefined, stateDir, baseEnv: {} }).toSorted(),
    ).toEqual([path.join(homedir, "work-codex"), "/shadow/codex", "/personal/codex"].toSorted());
  });

  it("never reaches outside an isolated profile for an instance without a home", () => {
    const profile = { isDefault: false } as Parameters<
      typeof resolveCodexLaunchHomes
    >[0]["profile"];
    expect(
      resolveCodexLaunchHomes({
        settings: decodeSettings({}),
        profile,
        stateDir,
        baseEnv: { CODEX_HOME: "/env/codex" },
      }),
    ).toEqual([]);
    expect(
      resolveCodexLaunchHomes({
        settings: decodeSettings({
          providers: { codex: { homePath: "/state/profile/provider-homes/codex" } },
        }),
        profile,
        stateDir,
        baseEnv: {},
      }),
    ).toEqual(["/state/profile/provider-homes/codex"]);
  });

  it("honors a CODEX_HOME set in the instance environment", () => {
    const settings = decodeSettings({
      providerInstances: {
        codex: {
          driver: "codex",
          environment: [{ name: "CODEX_HOME", value: "/instance/codex" }],
          config: {},
        },
      },
    });
    expect(
      resolveCodexLaunchHomes({ settings, profile: undefined, stateDir, baseEnv: {} }),
    ).toEqual(["/instance/codex"]);
  });
});
