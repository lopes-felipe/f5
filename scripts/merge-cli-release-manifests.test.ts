import { expect, it } from "vitest";
import { mergeCliManifests } from "./merge-cli-release-manifests";
import { CLI_TARGETS } from "@t3tools/shared/cliRelease";
it("publishes a complete f5-owned manifest and rejects missing targets or mixed versions", () => {
  const manifests = CLI_TARGETS.map((target) => ({
    schemaVersion: 1 as const,
    version: "1.0.0",
    artifacts: [
      {
        target,
        url: `https://github.com/lopes-felipe/f5/releases/download/v1.0.0/${target}.tar.gz`,
        size: 100,
        sha256: "a".repeat(64),
      },
    ],
  }));
  expect(mergeCliManifests(manifests).artifacts).toHaveLength(5);
  expect(() => mergeCliManifests(manifests.slice(1))).toThrow("five");
  expect(() => mergeCliManifests([...manifests, { ...manifests[0]!, version: "2.0.0" }])).toThrow(
    "match",
  );
});
