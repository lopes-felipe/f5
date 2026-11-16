import { describe, expect, it } from "vitest";

import { digestShas } from "./upstreamPorts";
import {
  archiveContext,
  parseArchive,
  pendingArchiveShas,
  remainingLegacyShas,
  validateArchive,
  validateArchiveProvenance,
} from "./upstreamPortsArchive";

const sha = (seed: string) => seed.padStart(40, "0");

function fixture(overrides: Record<string, unknown> = {}) {
  const intervalShas = [sha("b2"), sha("b1")];
  const legacyShas = [sha("c1")];
  return {
    schemaVersion: 6,
    entries: [
      { upstreamSha: sha("b1"), subject: "one", disposition: "not-applicable", reason: "x" },
      {
        upstreamSha: sha("b2"),
        subject: "two",
        disposition: "deferred",
        reason: "later",
        plannedWorkstream: "3",
      },
      { upstreamSha: sha("c1"), subject: "old", disposition: "deferred", reason: "old" },
    ],
    intervals: [
      {
        baseSha: sha("a0"),
        targetSha: sha("b2"),
        selection: "first-parent",
        count: 2,
        digest: digestShas(intervalShas),
        upstreamShas: intervalShas,
      },
    ],
    legacyCoverage: { count: 1, digest: digestShas(legacyShas), upstreamShas: legacyShas },
    legacyProvenance: [],
    ...overrides,
  };
}

describe("schema-6 archive", () => {
  it("validates structure and digests without evidence checks", () => {
    const archive = parseArchive(JSON.stringify(fixture()));
    expect(validateArchive(archive)).toEqual([]);
    expect(pendingArchiveShas(archive)).toEqual([]);
    const context = archiveContext(archive);
    expect(context.lastTargetSha).toBe(sha("b2"));
    expect([...context.deferredSubjects.keys()]).toEqual([sha("b2"), sha("c1")]);
    expect(remainingLegacyShas(archive, new Set([sha("c1")]))).toEqual([sha("b2")]);
  });

  it("reports digest drift and pending records", () => {
    const broken = fixture();
    broken.intervals[0]!.digest = "0".repeat(64);
    broken.entries[0] = { ...broken.entries[0]!, reviewStatus: "pending" } as never;
    const archive = parseArchive(JSON.stringify(broken));
    expect(validateArchive(archive).join("\n")).toContain("digest differs");
    expect(pendingArchiveShas(archive)).toEqual([sha("b1")]);
  });

  it("rejects other schema versions", () => {
    expect(() => parseArchive(JSON.stringify({ schemaVersion: 7 }))).toThrow("schema-6");
  });

  it("checks provenance against first-parent history and subjects", () => {
    const archive = parseArchive(JSON.stringify(fixture()));
    const git = (subjectOfB1: string) => (args: ReadonlyArray<string>) =>
      args[0] === "rev-list"
        ? [sha("b2"), sha("b1"), sha("a0")].join("\n")
        : [
            `${sha("b2")}\x1ftwo`,
            `${sha("b1")}\x1f${subjectOfB1}`,
            `${sha("c1")}\x1fold`,
            `${sha("a0")}\x1fbase`,
          ].join("\n");
    expect(validateArchiveProvenance(archive, git("one"), "upstream/main")).toEqual([]);
    expect(validateArchiveProvenance(archive, git("renamed"), "upstream/main")).toEqual([
      `archive subject differs for ${sha("b1")}`,
    ]);
  });
});
