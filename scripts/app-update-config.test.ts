import { describe, expect, it } from "vitest";
import { parseAppUpdateConfig, verifyAppUpdateConfig } from "./lib/app-update-config.ts";

// Shape written by electron-builder 26.15.3 for the pinned GitHub publish config.
const unsigned = `owner: lopes-felipe
repo: f5
provider: github
releaseType: release
channel: latest
updaterCacheDirName: f5-desktop-updater
`;

describe("packaged app-update.yml", () => {
  it("accepts the production feed for unsigned builds", () => {
    verifyAppUpdateConfig(unsigned, { channel: "latest" });
    verifyAppUpdateConfig(unsigned.replace("channel: latest", "channel: beta"), {
      channel: "beta",
    });
  });
  it.each([
    ["owner: lopes-felipe", "owner: someone-else", /owner/],
    ["repo: f5", "repo: fork", /repo/],
    ["provider: github", "provider: generic", /provider/],
    ["channel: latest", "channel: beta", /channel/],
    ["releaseType: release", "releaseType: draft", /releaseType/],
  ])("rejects %s replaced by %s", (from, to, error) => {
    expect(() => verifyAppUpdateConfig(unsigned.replace(from, to), { channel: "latest" })).toThrow(
      error,
    );
  });
  it("rejects host, protocol and token overrides", () => {
    for (const extra of ["host: 127.0.0.1:8080", "protocol: http", "token: secret"])
      expect(() => verifyAppUpdateConfig(`${unsigned}${extra}\n`, { channel: "latest" })).toThrow(
        /must not override/,
      );
  });
  it("rejects a publisherName in unsigned builds and requires the signer in signed builds", () => {
    const signed = `${unsigned}publisherName:\n  - F5 Publisher\n`;
    expect(() => verifyAppUpdateConfig(signed, { channel: "latest" })).toThrow(/Unsigned/);
    verifyAppUpdateConfig(signed, { channel: "latest", publisherName: "F5 Publisher" });
    expect(() =>
      verifyAppUpdateConfig(signed, { channel: "latest", publisherName: "Other" }),
    ).toThrow(/publisherName/);
    expect(() =>
      verifyAppUpdateConfig(unsigned, { channel: "latest", publisherName: "F5 Publisher" }),
    ).toThrow(/publisherName/);
  });
  it("parses quoted scalars and rejects malformed or duplicate keys", () => {
    expect(parseAppUpdateConfig("owner: 'lopes-felipe'\nrepo: \"f5\"\n")).toEqual({
      owner: "lopes-felipe",
      repo: "f5",
    });
    expect(() => parseAppUpdateConfig("owner lopes-felipe\n")).toThrow(/Invalid/);
    expect(() => parseAppUpdateConfig("repo: f5\nrepo: fork\n")).toThrow(/Duplicate/);
  });
});
