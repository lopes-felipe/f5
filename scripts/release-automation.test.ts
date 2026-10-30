import { describe, expect, it } from "vitest";
import {
  candidateVersion,
  parseStableIntent,
  pendingStableRequests,
  releaseComponents,
  validateCandidate,
  type ReleaseCandidate,
  type StableRequest,
} from "./release/release-candidate.ts";
import {
  artifactEntries,
  assertPublishableVersion,
  automationMode,
  missingUploads,
  selectPublication,
} from "./release/release-publication.ts";
import { transientInstallFailure } from "./retry-install.ts";
import { upgradePlan, sameBaselines } from "./release/release-upgrade-proof.ts";
import { windowsUpgradeAssets } from "./published-windows-upgrade.ts";
import { readFileSync, readdirSync } from "node:fs";
import { parse } from "yaml";
const sha = "a".repeat(40),
  next = "b".repeat(40),
  later = "c".repeat(40);
const request: StableRequest = {
  version: "0.1.2",
  requestId: "00000000-0000-4000-8000-000000000001",
  sourceSha: next,
};
const recovery: StableRequest = {
  ...request,
  requestId: "00000000-0000-4000-8000-000000000002",
  supersedes: request.requestId,
  sourceSha: later,
};
const input = { sourceSha: next, anchorSha: sha, baseVersion: "0.1.1", distance: 9, request: null };
const hash = "d".repeat(64);
export function fixtureCandidate(): ReleaseCandidate {
  return {
    schemaVersion: 1,
    sourceSha: next,
    version: "0.1.2-beta.9",
    channel: "beta",
    kind: "beta",
    profile: "all",
    anchorSha: sha,
    stableIntent: null,
    runId: 100,
    runAttempt: 2,
    createdAt: "2026-10-30T10:00:00Z",
    toolchain: { node: "v24.13.1", bun: "1.3.11", lockSha256: hash },
    windowsBaselines: [],
    artifacts: releaseComponents("all").map((component, index) => ({
      id: index + 1,
      name: component + "-attempt-1",
      digest: "sha256:" + hash,
      component,
      receipt: {
        component,
        sourceSha: next,
        version: "0.1.2-beta.9",
        runId: 100,
        runAttempt: 1,
        ...(component.startsWith("cli-") ? { cliUpgradeBaseline: "0.1.1" } : {}),
        toolchain: {
          node: "v26.10.0",
          bun: "1.3.11",
          platform: component.split("-")[1]!.replace(/^mac$/, "darwin").replace(/^win$/, "win32"),
          arch: component.split("-")[2]!,
          image: "runner/20261030",
        },
        files: [{ name: component + ".tar.gz", size: 20, sha256: hash }],
      },
    })),
  };
}
describe("release ordering and deterministic versions", () => {
  it("uses first-parent distance, permits gaps, and never makes a stable intent into a beta", () => {
    expect(candidateVersion(input).version).toBe("0.1.2-beta.9");
    expect(candidateVersion({ ...input, distance: 12 }).version).toBe("0.1.2-beta.12");
    expect(candidateVersion({ ...input, request })).toEqual({
      version: "0.1.2",
      kind: "stable",
      channel: "latest",
    });
    expect(
      candidateVersion({
        ...input,
        sourceSha: later,
        anchorSha: next,
        baseVersion: "0.1.2",
        distance: 2,
        request,
      }).version,
    ).toBe("0.1.3-beta.2");
    expect(() => candidateVersion({ ...input, distance: 0 })).toThrow();
  });
  it("ignores duplicate and out-of-order events by selecting durable main order", () => {
    const green = [
      { sourceSha: next, order: 2 },
      { sourceSha: sha, order: 1 },
      { sourceSha: later, order: 3 },
    ];
    expect(selectPublication(green, [])?.sourceSha).toBe(later);
    expect(selectPublication(green.toReversed(), [])?.sourceSha).toBe(later);
    expect(selectPublication([...green, ...green], [])?.sourceSha).toBe(later);
  });
  it("holds later betas behind failed stable candidates until explicit recovery", () => {
    expect(selectPublication([{ sourceSha: later, order: 3 }], [request])).toBeNull();
    expect(
      selectPublication(
        [
          { sourceSha: next, order: 2 },
          { sourceSha: later, order: 3 },
        ],
        [request],
      )?.sourceSha,
    ).toBe(next);
    expect(pendingStableRequests([request, recovery], new Map())).toEqual([recovery]);
    const third = {
      ...recovery,
      requestId: "00000000-0000-4000-8000-000000000003",
      supersedes: recovery.requestId,
      sourceSha: sha,
    };
    expect(pendingStableRequests([request, recovery, third], new Map())).toEqual([third]);
    expect(pendingStableRequests([request, recovery, third], new Map([["0.1.2", sha]]))).toEqual(
      [],
    );
    expect(pendingStableRequests([request, recovery], new Map([["0.1.2", later]]))).toEqual([]);
    expect(() =>
      pendingStableRequests(
        [request, { ...request, requestId: recovery.requestId, sourceSha: later }],
        new Map(),
      ),
    ).toThrow();
    expect(() =>
      pendingStableRequests([request, { ...recovery, version: "0.1.3" }], new Map()),
    ).toThrow();
    expect(() => pendingStableRequests([request, recovery], new Map([["0.1.2", next]]))).toThrow();
  });
});
describe("candidate identity and immutable uploads", () => {
  it("requalifies only affected native targets when baselines change while candidates are held", () => {
    const candidate = { ...fixtureCandidate(), version: "0.1.3-beta.9" };
    const release = (version: string) => ({
      tag_name: "v" + version,
      draft: false,
      prerelease: false,
      assets: windowsUpgradeAssets(version, "latest").map((name) => ({ name })),
    });
    const before = upgradePlan(candidate, [release("0.1.1")]);
    expect(before.cliTargets).toEqual([]);
    const after = upgradePlan(candidate, [release("0.1.1"), release("0.1.2")]);
    expect(after.key).not.toBe(before.key);
    expect(sameBaselines(before.baselines, after.baselines)).toBe(false);
    expect(after.cliTargets).toHaveLength(5);
    expect(after.cliTargets.map((t) => t.artifact).sort()).toEqual(
      candidate.artifacts
        .filter((a) => a.component.startsWith("cli-"))
        .map((a) => a.name)
        .sort(),
    );
    const stale = candidate.artifacts.find((a) => a.component === "cli-linux-arm64")!;
    const one = upgradePlan(
      {
        ...candidate,
        artifacts: candidate.artifacts.map((a) =>
          a === stale ? { ...a, receipt: { ...a.receipt, cliUpgradeBaseline: "0.1.0" } } : a,
        ),
      },
      [release("0.1.1")],
    );
    expect(one.cliTargets.map((t) => t.target)).toEqual(["linux-arm64"]);
  });
  it("accepts retained artifacts from successful earlier attempts and rejects mismatched sources/runs", () => {
    expect(() => validateCandidate(fixtureCandidate())).not.toThrow();
    const changes = [
      { sourceSha: sha },
      { runId: 99 },
      { runAttempt: 3 },
      { version: "0.1.3-beta.9" },
    ];
    for (const change of changes) {
      const candidate = fixtureCandidate();
      const artifacts = [...candidate.artifacts];
      artifacts[0] = { ...artifacts[0]!, receipt: { ...artifacts[0]!.receipt, ...change } };
      expect(() => validateCandidate({ ...candidate, artifacts })).toThrow();
    }
  });
  it("blocks corrupt ZIP digests, incomplete target sets, duplicate components and traversal", () => {
    const c = fixtureCandidate();
    expect(() => validateCandidate({ ...c, artifacts: c.artifacts.slice(1) })).toThrow();
    expect(() =>
      validateCandidate({ ...c, artifacts: [c.artifacts[1]!, ...c.artifacts.slice(1)] }),
    ).toThrow();
    expect(() =>
      validateCandidate({
        ...c,
        artifacts: [{ ...c.artifacts[0]!, digest: "sha256:broken" }, ...c.artifacts.slice(1)],
      }),
    ).toThrow();
    for (const names of [[], ["../file"], ["file", "file"], ["dir/file"], ["link/"]])
      expect(() => artifactEntries(names)).toThrow();
    expect(() => artifactEntries(["F5.exe", "latest.yml"])).not.toThrow();
  });
  it("resumes interrupted uploads without replacing matching assets", () => {
    const files = [
      { name: "a", size: 10, sha256: hash },
      { name: "b", size: 20, sha256: hash },
    ];
    const uploaded = [{ name: "a", size: 10, digest: "sha256:" + hash, state: "uploaded" }];
    expect(missingUploads(files, uploaded)).toEqual(["b"]);
    expect(missingUploads(files, [...uploaded, { ...uploaded[0]!, name: "b", size: 20 }])).toEqual(
      [],
    );
    for (const change of [
      { digest: "sha256:" + "e".repeat(64) },
      { size: 9 },
      { state: "starter" },
      { name: "unexpected" },
    ])
      expect(() => missingUploads(files, [{ ...uploaded[0]!, ...change }])).toThrow();
    expect(() => missingUploads(files, [...uploaded, ...uploaded])).toThrow();
    expect(() => assertPublishableVersion(fixtureCandidate(), ["0.1.2-beta.10"])).toThrow();
  });
  it("defaults to shadow and rejects malformed intents and retrying persistent failures", () => {
    expect(automationMode(undefined)).toBe("shadow");
    expect(() => automationMode("enabled")).toThrow();
    expect(() => parseStableIntent({ ...request, version: "0.1.2-beta.1" })).toThrow();
    expect(() => parseStableIntent({ ...request, requestId: "newline\n" })).toThrow();
    expect(transientInstallFailure("ECONNRESET")).toBe(true);
    expect(transientInstallFailure("HTTP 503")).toBe(true);
    expect(transientInstallFailure("checksum ECONNRESET")).toBe(false);
    expect(transientInstallFailure("frozen lockfile had changes")).toBe(false);
  });
});
it("keeps the macOS real-Git matrix exhaustive when a suite is added", () => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const suites = readdirSync(new URL("../apps/server/integration/git/extended", import.meta.url))
    .filter((f) => f.endsWith(".extended.test.ts"))
    .map((f) => f.replace(".extended.test.ts", ""))
    .sort();
  expect(workflow.jobs["macos-git"].strategy.matrix.suite.toSorted()).toEqual(suites);
  expect(workflow.jobs["ci-result"].needs).toEqual(
    expect.arrayContaining([
      "macos-workspaces",
      "macos-server-unit",
      "macos-integration",
      "macos-git",
      "macos-desktop",
    ]),
  );
});
