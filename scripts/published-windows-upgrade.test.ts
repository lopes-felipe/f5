import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  publishedWindowsBaselines,
  publishedWindowsUpgradeMatrix,
  verifyWindowsUpgradeArtifacts,
  windowsUpgradeAssets,
} from "./published-windows-upgrade.ts";
import type { PublishedReleaseSummary, ReleaseChannel } from "./lib/release-profile.ts";
import { dryRunReleaseVersion } from "./lib/release-qualification.ts";
import { preparePublishedWindowsUpgrade } from "./prepare-published-windows-upgrade.ts";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function release(version: string, draft = false): PublishedReleaseSummary {
  return {
    tag_name: `v${version}`,
    draft,
    assets: windowsUpgradeAssets(version, version.includes("-beta.") ? "beta" : "latest").map(
      (name) => ({ name }),
    ),
  };
}

describe("published Windows baseline", () => {
  it("chooses the latest published version numerically, ignoring drafts and API order", () => {
    expect(
      publishedWindowsBaselines(
        [release("0.1.1-beta.2"), release("0.1.1-beta.20", true), release("0.1.1-beta.10")],
        "0.1.1-beta.11",
        "beta",
      ),
    ).toEqual([{ baseline: "0.1.1-beta.10", baselineChannel: "beta", clientChannel: "beta" }]);
  });
  it("covers both stable clients and beta-to-stable upgrades", () => {
    const releases = [release("0.1.1"), release("0.2.0-beta.1")];
    expect(publishedWindowsBaselines(releases, "0.2.0", "latest")).toEqual([
      { baseline: "0.1.1", baselineChannel: "latest", clientChannel: "latest" },
      { baseline: "0.2.0-beta.1", baselineChannel: "beta", clientChannel: "beta" },
    ]);
  });
  it("starts beta rehearsals from a newer stable release that beta users already follow", () => {
    expect(
      publishedWindowsBaselines(
        [release("0.1.1-beta.2"), release("0.1.1")],
        "0.2.0-beta.1",
        "beta",
      ),
    ).toEqual([{ baseline: "0.1.1", baselineChannel: "latest", clientChannel: "beta" }]);
  });
  it("still tests beta users when the first stable release has no stable baseline", () => {
    expect(publishedWindowsBaselines([release("0.1.1-beta.1")], "0.1.1", "latest")).toEqual([
      { baseline: "0.1.1-beta.1", baselineChannel: "beta", clientChannel: "beta" },
    ]);
  });
  it("keeps stable and beta preferences separate even on the same installed version", () => {
    expect(publishedWindowsBaselines([release("0.1.1")], "0.1.2", "latest")).toEqual([
      { baseline: "0.1.1", baselineChannel: "latest", clientChannel: "latest" },
      { baseline: "0.1.1", baselineChannel: "latest", clientChannel: "beta" },
    ]);
  });
  it("only permits skipping when no stable or beta release has been published", () => {
    expect(
      publishedWindowsBaselines([release("0.1.1-beta.1", true)], "0.1.1-beta.2", "beta"),
    ).toEqual([]);
    expect(publishedWindowsUpgradeMatrix([], "0.1.1-beta.1", "beta")).toEqual({
      include: [{ baseline: "", baselineChannel: "beta", clientChannel: "beta" }],
    });
    expect(() =>
      publishedWindowsBaselines(
        [{ ...release("0.1.1-beta.1"), assets: [] }],
        "0.1.1-beta.2",
        "beta",
      ),
    ).toThrow(/missing/);
  });
  it.each(["0.1.1-beta.1", "0.1.1-beta.0"])("rejects a non-upgrade target %s", (target) => {
    expect(() => publishedWindowsBaselines([release("0.1.1-beta.1")], target, "beta")).toThrow(
      /must exceed/,
    );
  });
  it.each([0, 1, 2])(
    "requires published installer, blockmap and feed (missing index %s)",
    (index) => {
      const baseline = release("0.1.1-beta.1");
      expect(() =>
        publishedWindowsBaselines(
          [{ ...baseline, assets: baseline.assets!.filter((_, i) => i !== index) }],
          "0.1.1-beta.2",
          "beta",
        ),
      ).toThrow(/missing/);
    },
  );
  it("requires preparing the next stable version before another dry run", () => {
    expect(() =>
      publishedWindowsBaselines([release("0.1.1")], dryRunReleaseVersion("0.1.1", "42"), "latest"),
    ).toThrow(/prepare-release/);
    expect(
      publishedWindowsBaselines(
        [release("0.1.1-beta.2")],
        dryRunReleaseVersion("0.1.1-beta.2", "42"),
        "beta",
      ),
    ).toHaveLength(1);
  });
});

function artifacts(
  channel: ReleaseChannel = "beta",
  version = channel === "beta" ? "0.1.1-beta.1" : "0.1.1",
) {
  const dir = mkdtempSync(join(tmpdir(), "f5-published-upgrade-"));
  directories.push(dir);
  const installer = `F5-${version}-x64.exe`;
  const bytes = Buffer.from("installer bytes");
  const manifest = `version: ${version}
files:
  - url: ${installer}
    sha512: ${createHash("sha512").update(bytes).digest("base64")}
    size: ${bytes.length}
path: ${installer}
sha512: ${createHash("sha512").update(bytes).digest("base64")}
releaseDate: '2026-10-30T00:00:00Z'
`;
  writeFileSync(join(dir, installer), bytes);
  writeFileSync(join(dir, `${installer}.blockmap`), "blockmap");
  writeFileSync(join(dir, `${channel}.yml`), manifest);
  return { dir, version, installer, manifest };
}

describe("Windows installer verification", () => {
  it.each(["latest", "beta"] as const)("accepts intact %s assets", (channel) => {
    const { dir, version } = artifacts(channel);
    expect(() => verifyWindowsUpgradeArtifacts(dir, version, channel)).not.toThrow();
  });
  it("rejects installer tampering before executing it", () => {
    const { dir, version, installer } = artifacts();
    writeFileSync(join(dir, installer), "different bytes");
    expect(() => verifyWindowsUpgradeArtifacts(dir, version, "beta")).toThrow(/checksum/);
  });
  it.each(["../outside.exe", "other.exe"])("rejects unexpected installer path %s", (path) => {
    const { dir, version, installer, manifest } = artifacts();
    writeFileSync(join(dir, "beta.yml"), manifest.replaceAll(installer, path));
    expect(() => verifyWindowsUpgradeArtifacts(dir, version, "beta")).toThrow(/manifest/);
  });
  it("rejects a manifest for a different version", () => {
    const { dir, version, manifest } = artifacts();
    writeFileSync(join(dir, "beta.yml"), manifest.replace(`version: ${version}`, "version: 0.1.0"));
    expect(() => verifyWindowsUpgradeArtifacts(dir, version, "beta")).toThrow(/manifest/);
  });
  it("requires the differential download blockmap", () => {
    const { dir, version, installer } = artifacts();
    writeFileSync(join(dir, `${installer}.blockmap`), "");
    expect(() => verifyWindowsUpgradeArtifacts(dir, version, "beta")).toThrow(/blockmap/);
  });
});

function preparation(
  published: PublishedReleaseSummary[] = [],
  baseline = "",
  channel: ReleaseChannel = "latest",
  clientChannel: ReleaseChannel = channel,
) {
  const target = channel === "beta" ? "0.2.0-beta.1" : "0.2.0";
  const candidate = artifacts(channel, target);
  const output = join(candidate.dir, "github-output");
  const baselineDir = join(candidate.dir, "baseline");
  const logDir = join(candidate.dir, "logs");
  const dependencies = {
    releases: vi.fn(() => published),
    download: vi.fn<(repository: string, baseline: string, names: string[], dir: string) => void>(),
  };
  const run = (extra: string[] = []) =>
    preparePublishedWindowsUpgrade(
      [
        "--target",
        target,
        "--channel",
        channel,
        "--baseline",
        baseline,
        "--client-channel",
        clientChannel,
        "--target-dir",
        candidate.dir,
        "--baseline-dir",
        baselineDir,
        "--log-dir",
        logDir,
        ...extra,
      ],
      { GITHUB_REPOSITORY: "lopes-felipe/f5", GITHUB_OUTPUT: output },
      dependencies,
    );
  return { run, output, baselineDir, logDir, dependencies, candidate };
}

describe("published upgrade preparation entry point", () => {
  it("finishes the pinned check after a newer baseline appears, without rebuilding the installer", () => {
    const source = artifacts("latest", "0.1.1");
    const prepared = preparation([release("0.1.1"), release("0.1.2")], "0.1.1", "beta", "beta");
    prepared.dependencies.download.mockImplementation((_repository, _baseline, _names, dir) => {
      cpSync(source.dir, dir, { recursive: true });
    });
    expect(() => prepared.run()).toThrow(/plan changed/);
    prepared.run(["--pinned-baseline"]);
    expect(readFileSync(prepared.output, "utf8")).toContain("baseline=0.1.1");
    expect(prepared.dependencies.download).toHaveBeenCalledTimes(1);
  });
  it("records a first-release skip and emits the outputs consumed by Actions", () => {
    const prepared = preparation();
    prepared.run();
    expect(readFileSync(prepared.output, "utf8")).toBe(
      "available=false\nbaseline=\nbaseline_channel=latest\n",
    );
    expect(
      JSON.parse(readFileSync(join(prepared.logDir, "published-upgrade.json"), "utf8")),
    ).toMatchObject({ baseline: null, target: "0.2.0", clientChannel: "latest" });
    expect(prepared.dependencies.download).not.toHaveBeenCalled();
  });
  it("verifies the candidate before consulting releases, even if it would skip", () => {
    const prepared = preparation();
    writeFileSync(join(prepared.candidate.dir, prepared.candidate.installer), "corrupt");
    expect(prepared.run).toThrow(/checksum/);
    expect(prepared.dependencies.releases).not.toHaveBeenCalled();
    expect(prepared.dependencies.download).not.toHaveBeenCalled();
    expect(existsSync(prepared.output)).toBe(false);
  });
  it("downloads the stable baseline's real manifest for a beta client", () => {
    const source = artifacts("latest", "0.1.1");
    const prepared = preparation([release("0.1.1")], "0.1.1", "beta", "beta");
    prepared.dependencies.download.mockImplementation((_repository, _baseline, _names, dir) => {
      cpSync(source.dir, dir, { recursive: true });
    });
    prepared.run();
    expect(prepared.dependencies.download).toHaveBeenCalledWith(
      "lopes-felipe/f5",
      "0.1.1",
      ["F5-0.1.1-x64.exe", "F5-0.1.1-x64.exe.blockmap", "latest.yml"],
      prepared.baselineDir,
    );
    expect(readFileSync(prepared.output, "utf8")).toBe(
      "available=true\nbaseline=0.1.1\nbaseline_channel=latest\n",
    );
    expect(
      JSON.parse(readFileSync(join(prepared.logDir, "published-upgrade.json"), "utf8")),
    ).toMatchObject({ baselineChannel: "latest", clientChannel: "beta", channel: "beta" });
  });
  it("fails instead of skipping if published releases changed after preflight", () => {
    const prepared = preparation([release("0.1.1")]);
    expect(prepared.run).toThrow(/plan changed/);
    expect(existsSync(prepared.output)).toBe(false);
  });
  it("never emits a successful gate after a corrupt baseline download", () => {
    const source = artifacts("latest", "0.1.1");
    const prepared = preparation([release("0.1.1")], "0.1.1", "latest", "latest");
    prepared.dependencies.download.mockImplementation((_repository, _baseline, _names, dir) => {
      cpSync(source.dir, dir, { recursive: true });
      writeFileSync(join(dir, source.installer), "corrupt");
    });
    expect(prepared.run).toThrow(/checksum/);
    expect(existsSync(prepared.output)).toBe(false);
  });
  it("propagates network failures without reporting a successful skip", () => {
    const prepared = preparation([release("0.1.1")], "0.1.1", "latest", "latest");
    prepared.dependencies.download.mockImplementation(() => {
      throw new Error("offline");
    });
    expect(prepared.run).toThrow("offline");
    expect(existsSync(prepared.output)).toBe(false);
  });
});

it("blocks candidate validation on upgrade checks that consume the shipping Windows artifact", () => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
  );
  expect(workflow.jobs.candidate.needs).toContain("windows-published-upgrade");
  const upgrade = workflow.jobs["windows-published-upgrade"];
  expect(upgrade.needs).toContain("windows-desktop");
  expect(upgrade.needs).not.toContain("mac-desktop");
  expect(upgrade.strategy.matrix).toContain("needs.preflight.outputs.windows_upgrade_matrix");
  expect(upgrade.uses).toBe("./.github/workflows/release-published-upgrade.yml");
  expect(upgrade.with.artifact).toBe("desktop-win-x64-attempt-${{ github.run_attempt }}");
  const reusable = parse(
    readFileSync(
      new URL("../.github/workflows/release-published-upgrade.yml", import.meta.url),
      "utf8",
    ),
  );
  const steps = reusable.jobs.upgrade.steps;
  expect(steps.some((step: { run?: string }) => step.run?.includes("--published-baseline"))).toBe(
    true,
  );
  expect(steps.some((step: { run?: string }) => step.run?.includes("build-desktop"))).toBe(false);
});
