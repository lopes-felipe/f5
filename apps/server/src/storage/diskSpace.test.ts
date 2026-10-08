import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { type DiskSpaceStatus, ServerSettings } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  CRITICAL_DISK_SPACE_BYTES,
  diskSpaceHoldDetail,
  diskSpaceLevel,
  inspectVolumes,
  LOW_DISK_SPACE_BYTES,
  readVolumeStat,
  resolveWatchedPaths,
  shareInFlightProbes,
  worstDiskSpaceLevel,
} from "./diskSpace.ts";

const GB = 1024 ** 3;
const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("diskSpaceLevel", () => {
  it("warns below 10 GB and holds turns below 2 GB", () => {
    expect(LOW_DISK_SPACE_BYTES).toBe(10 * GB);
    expect(CRITICAL_DISK_SPACE_BYTES).toBe(2 * GB);
    expect(diskSpaceLevel(10 * GB)).toBe("ok");
    expect(diskSpaceLevel(10 * GB - 1)).toBe("low");
    expect(diskSpaceLevel(2 * GB)).toBe("low");
    expect(diskSpaceLevel(2 * GB - 1)).toBe("critical");
    expect(worstDiskSpaceLevel(["ok", "critical", "low"])).toBe("critical");
    expect(worstDiskSpaceLevel([])).toBe("ok");
  });
});

describe("inspectVolumes", () => {
  it("folds paths on one volume together and skips paths that cannot be read", async () => {
    const stats: Record<string, { device: number; freeBytes: number; totalBytes: number }> = {
      "/data/userdata": { device: 1, freeBytes: 5 * GB, totalBytes: 500 * GB },
      "/data/worktrees": { device: 1, freeBytes: 5 * GB, totalBytes: 500 * GB },
      "/home/.claude": { device: 1, freeBytes: 5 * GB, totalBytes: 500 * GB },
      "/external/codex": { device: 2, freeBytes: 1 * GB, totalBytes: 100 * GB },
    };
    const volumes = await inspectVolumes({
      watched: [
        { path: "/data/userdata", role: "userdata" },
        { path: "/data/worktrees", role: "userdata" },
        { path: "/external/codex", role: "codexHome" },
        { path: "/home/.claude", role: "claudeHome" },
        { path: "/unreadable", role: "codexHome" },
      ],
      readStat: async (target) => {
        const stat = stats[target];
        if (!stat) throw new Error("EACCES");
        return stat;
      },
    });
    expect(volumes).toEqual([
      {
        path: "/data/userdata",
        roles: ["userdata", "claudeHome"],
        freeBytes: 5 * GB,
        totalBytes: 500 * GB,
        level: "low",
      },
      {
        path: "/external/codex",
        roles: ["codexHome"],
        freeBytes: 1 * GB,
        totalBytes: 100 * GB,
        level: "critical",
      },
    ]);
  });

  it("skips a path whose probe does not settle", async () => {
    const volumes = await inspectVolumes({
      watched: [
        { path: "/data", role: "userdata" },
        { path: "/stalled-mount", role: "codexHome" },
      ],
      readStat: (target) =>
        target === "/stalled-mount"
          ? new Promise(() => {})
          : Promise.resolve({ device: 1, freeBytes: 50 * GB, totalBytes: 500 * GB }),
      probeTimeoutMs: 10,
    });
    expect(volumes.map((volume) => volume.path)).toEqual(["/data"]);
  });

  it("reuses a probe still pending for the same path", async () => {
    let probes = 0;
    let settle: (stat: {
      device: number;
      freeBytes: number;
      totalBytes: number;
    }) => void = () => {};
    const readStat = shareInFlightProbes(() => {
      probes += 1;
      return new Promise((resolve) => (settle = resolve));
    });
    const first = readStat("/stalled-mount");
    const second = readStat("/stalled-mount");
    expect(probes).toBe(1);
    settle({ device: 1, freeBytes: GB, totalBytes: GB });
    expect(await second).toEqual(await first);
    // Once it settles, the next check probes again.
    void readStat("/stalled-mount");
    expect(probes).toBe(2);
  });

  it("reads the nearest existing ancestor of a home that does not exist yet", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "f5-disk-space-"));
    roots.push(root);
    const missing = await readVolumeStat(path.join(root, "not", "created", "yet"));
    const existing = await readVolumeStat(root);
    expect(missing.device).toBe(existing.device);
    expect(missing.totalBytes).toBeGreaterThan(0);
  });
});

describe("resolveWatchedPaths", () => {
  it("watches userdata, worktrees and every enabled provider home", async () => {
    const settings = decodeSettings({
      providers: {
        claudeAgent: { homePath: "/homes/claude" },
        codex: { homePath: "/homes/codex" },
      },
    });
    const watched = await Effect.runPromise(
      resolveWatchedPaths({
        stateDir: "/state",
        worktreesDir: "/state/worktrees",
        settings,
        profile: undefined,
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(watched).toEqual(
      expect.arrayContaining([
        { path: "/state", role: "userdata" },
        { path: "/state/worktrees", role: "userdata" },
        { path: "/homes/claude/.claude", role: "claudeHome" },
        { path: "/homes/codex", role: "codexHome" },
      ]),
    );
  });

  it("skips disabled instances and still watches userdata without settings", async () => {
    const settings = decodeSettings({
      providers: {
        claudeAgent: { enabled: false, homePath: "/homes/claude" },
        codex: { enabled: false, homePath: "/homes/codex" },
      },
    });
    const disabled = await Effect.runPromise(
      resolveWatchedPaths({
        stateDir: "/state",
        worktreesDir: "/state/worktrees",
        settings,
        profile: undefined,
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(disabled.map((entry) => entry.role)).toEqual(["userdata", "userdata"]);
    const withoutSettings = await Effect.runPromise(
      resolveWatchedPaths({
        stateDir: "/state",
        worktreesDir: "/state/worktrees",
        settings: null,
        profile: undefined,
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(withoutSettings.map((entry) => entry.role)).toEqual(["userdata", "userdata"]);
  });
});

describe("diskSpaceHoldDetail", () => {
  const status = (volumes: DiskSpaceStatus["volumes"]): DiskSpaceStatus => ({
    level: worstDiskSpaceLevel(volumes.map((volume) => volume.level)),
    checkedAt: new Date(0).toISOString(),
    lowThresholdBytes: LOW_DISK_SPACE_BYTES,
    criticalThresholdBytes: CRITICAL_DISK_SPACE_BYTES,
    volumes,
    reclaimable: [],
  });

  it("does not hold turns while every volume has room", () => {
    expect(
      diskSpaceHoldDetail(
        status([
          { path: "/data", roles: ["userdata"], freeBytes: 3 * GB, totalBytes: GB, level: "low" },
        ]),
      ),
    ).toBeNull();
  });

  it("names the fullest critical volume and what F5 keeps on it", () => {
    const detail = diskSpaceHoldDetail(
      status([
        { path: "/data", roles: ["userdata"], freeBytes: GB, totalBytes: GB, level: "critical" },
        {
          path: "/home/.claude",
          roles: ["claudeHome", "codexHome"],
          freeBytes: 512 * 1024 ** 2,
          totalBytes: GB,
          level: "critical",
        },
      ]),
    );
    expect(detail).toContain("512 MB");
    expect(detail).toContain("Claude home, Codex home (/home/.claude)");
    expect(detail).toContain("Settings > Storage");
  });
});
