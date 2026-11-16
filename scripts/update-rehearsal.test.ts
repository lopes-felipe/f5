import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  rehearsalAppUpdateConfig,
  rehearsalVersions,
  verifyRehearsalAppUpdateConfig,
  startUpdateFeedEmulator,
  type UpdateFeedEmulator,
} from "./lib/update-rehearsal.ts";
import { parseAppUpdateConfig } from "./lib/app-update-config.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function emulator(): Promise<{ feed: UpdateFeedEmulator; url: (path: string) => string }> {
  const dir = mkdtempSync(join(tmpdir(), "f5-feed-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, content: string) => {
    writeFileSync(join(dir, name), content);
    return join(dir, name);
  };
  const feed = await startUpdateFeedEmulator({
    latest: "0.1.1",
    releases: [
      { version: "0.1.0", assets: { "F5-0.1.0-x64.exe.blockmap": write("old.blockmap", "old") } },
      {
        version: "0.1.1",
        assets: {
          "latest.yml": write("latest.yml", "version: 0.1.1\nsha512: real\n"),
          "F5-0.1.1-x64.exe": write("F5.exe", "0123456789"),
        },
      },
    ],
  });
  cleanups.push(() => feed.close());
  return { feed, url: (path) => `http://127.0.0.1:${feed.port}${path}` };
}

describe("rehearsal versions and feed config", () => {
  const productionConfig =
    "owner: lopes-felipe\nrepo: f5\nprovider: github\nreleaseType: release\nchannel: beta\n";
  it("keeps synthetic baselines unsigned and accepts a published unsigned baseline", () => {
    expect(() =>
      verifyRehearsalAppUpdateConfig(productionConfig, { channel: "beta" }),
    ).not.toThrow();
    expect(() =>
      verifyRehearsalAppUpdateConfig(productionConfig, {
        channel: "beta",
        publishedBaseline: true,
      }),
    ).not.toThrow();
    expect(() =>
      verifyRehearsalAppUpdateConfig(`${productionConfig}publisherName: F5 Publisher\n`, {
        channel: "beta",
      }),
    ).toThrow(/Unsigned/);
  });
  it.each(["publisherName: F5 Publisher", "publisherName:\n  - F5 Publisher"])(
    "preserves the signed published baseline's identity: %s",
    (publisher) => {
      const signed = `${productionConfig}${publisher}\n`;
      verifyRehearsalAppUpdateConfig(signed, { channel: "beta", publishedBaseline: true });
      expect(parseAppUpdateConfig(rehearsalAppUpdateConfig(signed, 4321)).publisherName).toEqual(
        parseAppUpdateConfig(signed).publisherName,
      );
    },
  );
  it.each(["publisherName:", "publisherName: ''", "publisherName:\n  - One\n  - Two"])(
    "rejects an invalid published signing identity: %s",
    (publisher) => {
      expect(() =>
        verifyRehearsalAppUpdateConfig(`${productionConfig}${publisher}\n`, {
          channel: "beta",
          publishedBaseline: true,
        }),
      ).toThrow(/publisherName/);
    },
  );
  it("still rejects a mismatched production feed for a signed published baseline", () => {
    expect(() =>
      verifyRehearsalAppUpdateConfig(
        `${productionConfig.replace("repo: f5", "repo: fork")}publisherName: F5 Publisher\n`,
        { channel: "beta", publishedBaseline: true },
      ),
    ).toThrow(/repo/);
  });
  it("derives stable baseline and next patch target", () => {
    expect(rehearsalVersions("0.1.0", "latest")).toEqual({ baseline: "0.1.0", target: "0.1.1" });
    expect(rehearsalVersions("0.1.9-dryrun.42", "latest")).toEqual({
      baseline: "0.1.9",
      target: "0.1.10",
    });
    expect(rehearsalVersions("0.2.0-beta.3", "beta")).toEqual({
      baseline: "0.2.0-beta.1",
      target: "0.2.0-beta.2",
    });
    expect(() => rehearsalVersions("v0.1.0", "latest")).toThrow();
    expect(() => rehearsalVersions("0.1.0", "alpha")).toThrow(/channel/);
  });
  it("adds a loopback host to the production feed only", () => {
    const original = "owner: lopes-felipe\nrepo: f5\nprovider: github\nchannel: latest\n";
    const config = parseAppUpdateConfig(rehearsalAppUpdateConfig(original, 4321));
    expect(config).toMatchObject({
      owner: "lopes-felipe",
      host: "127.0.0.1:4321",
      protocol: "http",
    });
    expect(() => rehearsalAppUpdateConfig(original.replace("lopes-felipe", "fork"), 1)).toThrow();
  });
});

describe("loopback GitHub feed emulator", () => {
  it("serves the custom-host routes electron-updater requests", async () => {
    const { url } = await emulator();
    const atom = await (await fetch(url("/lopes-felipe/f5/releases.atom"))).text();
    expect(atom).toMatch(
      /href="http:\/\/127\.0\.0\.1:\d+\/lopes-felipe\/f5\/releases\/tag\/v0\.1\.1"/,
    );
    expect(atom.indexOf("v0.1.1")).toBeLessThan(atom.indexOf("v0.1.0"));
    expect(
      await (await fetch(url("/api/v3/repos/lopes-felipe/f5/releases/latest"))).json(),
    ).toEqual({ tag_name: "v0.1.1" });
    expect(
      await (await fetch(url("/lopes-felipe/f5/releases/download/v0.1.1/latest.yml"))).text(),
    ).toContain("sha512: real");
    expect(
      await (
        await fetch(url("/lopes-felipe/f5/releases/download/v0.1.0/F5-0.1.0-x64.exe.blockmap"))
      ).text(),
    ).toBe("old");
    expect((await fetch(url("/lopes-felipe/f5/releases/download/v0.1.1/missing"))).status).toBe(
      404,
    );
  });
  it("supports single byte ranges", async () => {
    const { url } = await emulator();
    const response = await fetch(
      url("/lopes-felipe/f5/releases/download/v0.1.1/F5-0.1.1-x64.exe"),
      {
        headers: { range: "bytes=2-4" },
      },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(await response.text()).toBe("234");
  });
  it("simulates offline, corrupt manifests and interrupted installers", async () => {
    const { feed, url } = await emulator();
    feed.setMode("offline");
    await expect(fetch(url("/lopes-felipe/f5/releases.atom"))).rejects.toThrow();
    feed.setMode("corrupt-manifest");
    const yml = await (
      await fetch(url("/lopes-felipe/f5/releases/download/v0.1.1/latest.yml"))
    ).text();
    expect(yml).not.toContain("sha512: real");
    feed.setMode("drop-installer");
    await expect(
      fetch(url("/lopes-felipe/f5/releases/download/v0.1.1/F5-0.1.1-x64.exe")).then((r) =>
        r.arrayBuffer(),
      ),
    ).rejects.toThrow();
    feed.setMode("normal");
    expect(
      await (await fetch(url("/lopes-felipe/f5/releases/download/v0.1.1/F5-0.1.1-x64.exe"))).text(),
    ).toBe("0123456789");
    expect(feed.requests[0]).toBe("offline /lopes-felipe/f5/releases.atom");
  });
});
