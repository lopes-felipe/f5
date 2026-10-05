import { describe, expect, it } from "vitest";
import { cliTarget, parseRelease, selectArtifact } from "./cliRelease";
const artifact = {
  target: "linux-arm64",
  url: "https://github.com/lopes-felipe/f5/releases/download/v1.0.0/f5.tar.gz",
  sha256: "a".repeat(64),
  size: 100,
};
describe("F5 CLI release selection", () => {
  it("selects an exact platform/architecture and rejects Intel macOS", () => {
    const release = parseRelease({ schemaVersion: 1, version: "1.0.0", artifacts: [artifact] });
    expect(selectArtifact(release, cliTarget("linux", "arm64"))).toEqual(artifact);
    expect(() => selectArtifact(release, cliTarget("linux", "x64"))).toThrow("no archive");
    expect(() => cliTarget("darwin", "x64")).toThrow("Intel");
  });
  it("rejects mutable/unsafe manifest shapes and duplicate targets", () => {
    for (const artifacts of [
      [{ ...artifact, url: "http://host/file" }],
      [{ ...artifact, size: Infinity }],
      [artifact, artifact],
    ])
      expect(() => parseRelease({ schemaVersion: 1, version: "1.0.0", artifacts })).toThrow();
    expect(() =>
      parseRelease({ schemaVersion: 1, version: "../current", artifacts: [artifact] }),
    ).toThrow();
  });
});

it("compares release versions numerically and preserves prerelease precedence", async () => {
  const { compareCliReleaseVersions: compare } = await import("./cliRelease");
  expect(compare("1.10.0", "1.9.0")).toBe(1);
  expect(compare("1.0.0", "1.0.0-nightly.10")).toBe(1);
  expect(compare("1.0.0-nightly.2", "1.0.0-nightly.10")).toBe(-1);
  expect(compare("1.0.0-beta.1", "1.0.0-beta.1")).toBe(0);
});
