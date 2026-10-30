import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  publishedWindowsBaseline,
  verifyWindowsUpgradeArtifacts,
  windowsUpgradeAssets,
} from "./published-windows-upgrade.ts";
import type { PublishedReleaseSummary, ReleaseChannel } from "./lib/release-profile.ts";

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
      publishedWindowsBaseline(
        [release("0.1.1-beta.2"), release("0.1.1-beta.20", true), release("0.1.1-beta.10")],
        "0.1.1-beta.11",
        "beta",
      ),
    ).toBe("0.1.1-beta.10");
  });
  it("keeps stable and beta baselines on the requested feed", () => {
    const releases = [release("0.1.1"), release("0.2.0-beta.1")];
    expect(publishedWindowsBaseline(releases, "0.2.0", "latest")).toBe("0.1.1");
    expect(publishedWindowsBaseline(releases, "0.2.0-beta.2.dryrun.42", "beta")).toBe(
      "0.2.0-beta.1",
    );
  });
  it("only permits skipping when the channel has no published baseline", () => {
    expect(
      publishedWindowsBaseline([release("0.1.1-beta.1", true)], "0.1.1-beta.2", "beta"),
    ).toBeUndefined();
    expect(publishedWindowsBaseline([release("0.1.1-beta.1")], "0.1.1", "latest")).toBeUndefined();
    expect(() =>
      publishedWindowsBaseline(
        [{ ...release("0.1.1-beta.1"), assets: [] }],
        "0.1.1-beta.2",
        "beta",
      ),
    ).toThrow(/missing/);
  });
  it.each(["0.1.1-beta.1", "0.1.1-beta.0"])("rejects a non-upgrade target %s", (target) => {
    expect(() => publishedWindowsBaseline([release("0.1.1-beta.1")], target, "beta")).toThrow(
      /must exceed/,
    );
  });
  it.each([0, 1, 2])(
    "requires published installer, blockmap and feed (missing index %s)",
    (index) => {
      const baseline = release("0.1.1-beta.1");
      expect(() =>
        publishedWindowsBaseline(
          [{ ...baseline, assets: baseline.assets!.filter((_, i) => i !== index) }],
          "0.1.1-beta.2",
          "beta",
        ),
      ).toThrow(/missing/);
    },
  );
});

function artifacts(channel: ReleaseChannel = "beta") {
  const version = channel === "beta" ? "0.1.1-beta.1" : "0.1.1";
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

it("blocks assembly on the published upgrade and uses the release artifact", () => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
  );
  expect(workflow.jobs.assemble.needs).toContain("windows-published-upgrade");
  const upgrade = workflow.jobs["windows-published-upgrade"];
  expect(upgrade.needs).toContain("build-desktop");
  expect(upgrade.steps).toContainEqual({
    uses: "actions/download-artifact@v4",
    with: { name: "desktop-win-x64", path: "published-upgrade/target" },
  });
});
