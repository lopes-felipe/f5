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

describe("published rehearsal baseline", () => {
  it("has none before a Windows release is published", () => {
    expect(selectPublishedBaseline([preview], "beta")).toBeUndefined();
    expect(selectPublishedBaseline([preview, release("0.1.0", { draft: true })], "latest")).toBe(
      undefined,
    );
  });

  it("starts betas from the newest published beta", () => {
    const releases = [release("0.1.1-beta.1"), release("0.1.1-beta.2"), release("0.1.0"), preview];
    expect(selectPublishedBaseline(releases, "beta")).toEqual({
      tag: "v0.1.1-beta.2",
      version: "0.1.1-beta.2",
      channel: "beta",
      assets: ["F5-0.1.1-beta.2-x64.exe", "F5-0.1.1-beta.2-x64.exe.blockmap", "beta.yml"],
    });
  });

  it("starts stable releases from the newest stable, or the newest beta before one exists", () => {
    expect(
      selectPublishedBaseline([release("0.1.1-beta.1"), release("0.1.1-beta.2")], "latest"),
    ).toMatchObject({ version: "0.1.1-beta.2", channel: "beta" });
    expect(
      selectPublishedBaseline(
        [release("0.1.2-beta.1"), release("0.1.1"), release("0.1.0")],
        "latest",
      ),
    ).toMatchObject({ version: "0.1.1", channel: "latest" });
  });

  it("skips drafts and releases missing the installer, blockmap, manifest or checksums", () => {
    for (const omit of [
      "F5-0.1.1-beta.2-x64.exe",
      "F5-0.1.1-beta.2-x64.exe.blockmap",
      "beta.yml",
      "SHA256SUMS",
    ])
      expect(
        selectPublishedBaseline(
          [release("0.1.1-beta.1"), release("0.1.1-beta.2", { omit })],
          "beta",
        )?.version,
      ).toBe("0.1.1-beta.1");
    expect(
      selectPublishedBaseline(
        [release("0.1.1-beta.1"), release("0.1.1-beta.2", { draft: true })],
        "beta",
      )?.version,
    ).toBe("0.1.1-beta.1");
  });
});

describe("rehearsal target", () => {
  it("uses the release version when it is on the channel", () => {
    expect(rehearsalTarget("0.1.1-beta.2", "beta", "0.1.1-beta.1")).toBe("0.1.1-beta.2");
    expect(rehearsalTarget("0.1.1", "latest", "0.1.1-beta.2")).toBe("0.1.1");
  });

  it("gives check and dry-run builds the next version on the channel", () => {
    expect(rehearsalTarget("0.1.1-check.40", "latest", "0.1.1-beta.1")).toBe("0.1.1");
    expect(rehearsalTarget("0.1.1-check.40", "beta", "0.1.1-beta.1")).toBe("0.1.1-beta.2");
    expect(rehearsalTarget("0.1.2-dryrun.3", "beta", "0.1.1-beta.4")).toBe("0.1.2-beta.1");
    expect(rehearsalTarget("0.1.1-check.40", "latest", "0.1.1")).toBe("0.1.2");
    expect(rehearsalTarget("0.1.1-check.40", "beta", "0.1.1")).toBe("0.1.2-beta.1");
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
    writeFileSync(join(dir, "F5.exe"), "tampered");
    expect(() => verifyDownloadedChecksums(dir, sums, ["F5.exe"])).toThrow(
      "does not match SHA256SUMS",
    );
    expect(() => verifyDownloadedChecksums(dir, sums, ["beta.yml"])).toThrow("no entry");
  });
});
