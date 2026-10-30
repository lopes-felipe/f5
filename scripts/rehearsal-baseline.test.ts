import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  rehearsalTarget,
  selectPublishedBaseline,
  verifyDownloadedChecksums,
} from "./lib/rehearsal-baseline.ts";
import type { PublishedReleaseSummary } from "./lib/release-profile.ts";
import { rehearsalClient } from "./lib/update-rehearsal.ts";

function release(version: string, options: { draft?: boolean; omit?: string } = {}) {
  const manifest = version.includes("-") ? "beta.yml" : "latest.yml";
  const names = [
    `F5-${version}-x64.exe`,
    `F5-${version}-x64.exe.blockmap`,
    manifest,
    "SHA256SUMS",
    `F5-${version}-arm64.dmg`,
  ].filter((name) => name !== options.omit);
  return {
    tag_name: `v${version}`,
    draft: options.draft ?? false,
    assets: names.map((name) => ({ name })),
  } satisfies PublishedReleaseSummary;
}

const preview = {
  tag_name: "v0.0.11-computer-use-preview.1",
  draft: false,
  assets: [{ name: "F5-0.0.11-computer-use-preview.1-arm64.dmg" }],
};

const pick = (releases: PublishedReleaseSummary[], channel: "latest" | "beta") =>
  selectPublishedBaseline(releases, channel).baseline;

describe("published rehearsal baseline", () => {
  it("has none before a Windows release is published", () => {
    expect(selectPublishedBaseline([preview], "beta")).toEqual({
      baseline: undefined,
      skipped: [],
    });
    expect(pick([preview, release("0.1.0", { draft: true })], "latest")).toBeUndefined();
  });

  it("starts betas from the newest published release of either channel", () => {
    const releases = [release("0.1.1-beta.1"), release("0.1.1-beta.2"), release("0.1.0"), preview];
    expect(pick(releases, "beta")).toEqual({
      tag: "v0.1.1-beta.2",
      version: "0.1.1-beta.2",
      channel: "beta",
      assets: ["F5-0.1.1-beta.2-x64.exe", "F5-0.1.1-beta.2-x64.exe.blockmap", "beta.yml"],
    });
    // A stable install keeps the beta preference it saved before updating.
    expect(pick([release("0.1.1-beta.2"), release("0.1.1")], "beta")).toMatchObject({
      version: "0.1.1",
      channel: "latest",
    });
  });

  it("starts stable releases from the newest stable, or the newest beta before one exists", () => {
    expect(pick([release("0.1.1-beta.1"), release("0.1.1-beta.2")], "latest")).toMatchObject({
      version: "0.1.1-beta.2",
      channel: "beta",
    });
    expect(
      pick([release("0.1.2-beta.1"), release("0.1.1"), release("0.1.0")], "latest"),
    ).toMatchObject({ version: "0.1.1", channel: "latest" });
  });

  it("skips and reports releases missing the installer, blockmap, manifest or checksums", () => {
    for (const omit of [
      "F5-0.1.1-beta.2-x64.exe",
      "F5-0.1.1-beta.2-x64.exe.blockmap",
      "beta.yml",
      "SHA256SUMS",
    ]) {
      const selection = selectPublishedBaseline(
        [release("0.1.1-beta.1"), release("0.1.1-beta.2", { omit })],
        "beta",
      );
      expect(selection.baseline?.version).toBe("0.1.1-beta.1");
      expect(selection.skipped).toEqual([`v0.1.1-beta.2: missing ${omit}`]);
    }
    expect(
      pick([release("0.1.1-beta.1"), release("0.1.1-beta.2", { draft: true })], "beta")?.version,
    ).toBe("0.1.1-beta.1");
  });

  it("fails instead of falling back once Windows releases exist but none is usable", () => {
    expect(() =>
      selectPublishedBaseline([release("0.1.1-beta.1", { omit: "SHA256SUMS" })], "beta"),
    ).toThrow("v0.1.1-beta.1: missing SHA256SUMS");
    const renamed = { tag_name: "v0.1.1", draft: false, assets: [{ name: "F5-Setup-0.1.1.exe" }] };
    expect(() => selectPublishedBaseline([renamed], "latest")).toThrow(
      "v0.1.1: missing F5-0.1.1-x64.exe",
    );
  });
});

describe("rehearsal target", () => {
  it("uses the release version when it is on the channel", () => {
    expect(rehearsalTarget("0.1.1-beta.2", "beta", "0.1.1-beta.1")).toBe("0.1.1-beta.2");
    expect(rehearsalTarget("0.1.1", "latest", "0.1.1-beta.2")).toBe("0.1.1");
  });

  it("rejects a release version that is not above the baseline or not on the channel", () => {
    expect(() => rehearsalTarget("0.1.1-beta.1", "beta", "0.1.1-beta.1")).toThrow(
      "not above the baseline",
    );
    expect(() => rehearsalTarget("0.1.1", "latest", "0.1.2-beta.1")).toThrow(
      "not above the baseline",
    );
    expect(() => rehearsalTarget("0.1.1-beta.2", "latest", "0.1.1-beta.1")).toThrow(
      "not on the latest channel",
    );
  });

  it("gives check and dry-run builds the next version on the channel", () => {
    expect(rehearsalTarget("0.1.1-check.40", "latest", "0.1.1-beta.1")).toBe("0.1.1");
    expect(rehearsalTarget("0.1.1-check.40", "beta", "0.1.1-beta.1")).toBe("0.1.1-beta.2");
    expect(rehearsalTarget("0.1.2-dryrun.3", "beta", "0.1.1-beta.4")).toBe("0.1.2-beta.1");
    expect(rehearsalTarget("0.1.1-check.40", "latest", "0.1.1")).toBe("0.1.2");
    expect(rehearsalTarget("0.1.1-check.40", "beta", "0.1.1")).toBe("0.1.2-beta.1");
  });

  it("rejects other versions", () => {
    expect(() => rehearsalTarget("0.1.1-rc.1", "latest", "0.1.0")).toThrow(
      "Invalid rehearsal version",
    );
    expect(() => rehearsalTarget("0.1.0-check.1", "latest", "0.1.1-rc.1")).toThrow(
      "Invalid baseline version",
    );
  });
});

describe("rehearsal client", () => {
  it("keeps beta installs on beta and seeds beta for a stable install taking a beta", () => {
    expect(rehearsalClient("beta", "beta")).toEqual({ channel: "beta", seedBetaPreference: false });
    expect(rehearsalClient("beta", "latest")).toEqual({
      channel: "beta",
      seedBetaPreference: false,
    });
    expect(rehearsalClient("latest", "latest")).toEqual({
      channel: "stable",
      seedBetaPreference: false,
    });
    expect(rehearsalClient("latest", "beta")).toEqual({
      channel: "beta",
      seedBetaPreference: true,
    });
    expect(() => rehearsalClient("stable", "beta")).toThrow("Invalid channel: stable");
  });
});

describe("downloaded checksums", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");

  it("checks only the downloaded files against SHA256SUMS", () => {
    const dir = mkdtempSync(join(tmpdir(), "f5-baseline-"));
    dirs.push(dir);
    writeFileSync(join(dir, "F5.exe"), "installer");
    const sums = `${sha("installer")}  F5.exe\n${sha("other")}  F5.dmg\n`;
    expect(() => verifyDownloadedChecksums(dir, sums, ["F5.exe"])).not.toThrow();
    const crlf = sums.replaceAll("\n", "\r\n");
    expect(() => verifyDownloadedChecksums(dir, crlf, ["F5.exe"])).not.toThrow();
    writeFileSync(join(dir, "F5.exe"), "tampered");
    expect(() => verifyDownloadedChecksums(dir, sums, ["F5.exe"])).toThrow(
      "does not match SHA256SUMS",
    );
    expect(() => verifyDownloadedChecksums(dir, sums, ["beta.yml"])).toThrow("no entry");
  });
});
