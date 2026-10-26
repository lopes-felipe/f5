import { describe, expect, it } from "vitest";
import {
  INTEGRATION_ACCEPTANCE_CHECKS,
  INTEGRATION_REQUIRED_ASSERTIONS,
  PROVIDER_INTEGRATION_RECORDS,
  type CodexChromeRecord,
  type IntegrationAcceptanceReport,
} from "@t3tools/shared/providerIntegrationCertification";
import { promotionProblems, remoteTagCommit, type PromotionIo } from "./release-promotion.ts";

const TAG = "v1.2.3";
const TAG_COMMIT = "1".repeat(40);
const EVIDENCE_COMMIT = "2".repeat(40);
const DMG = "F5-1.2.3-arm64.dmg";
const DIGEST = "f".repeat(64);
const base = PROVIDER_INTEGRATION_RECORDS["codex-chrome"][0]!;
const certified: CodexChromeRecord = {
  ...base,
  id: "codex-chrome-darwin-arm64-26.1020.5",
  evidenceId: "evidence",
  evidenceCommit: EVIDENCE_COMMIT,
  toolNames: [...base.identity.allowedTools],
  toolInventorySha256: "d".repeat(64),
  identity: {
    ...base.identity,
    advertisedTools: base.identity.allowedTools.map((name) => ({ name, inputSchema: {} })),
  },
};
const acceptance: IntegrationAcceptanceReport = {
  kind: "acceptance",
  integration: "codex-chrome",
  tag: TAG,
  platform: "darwin",
  arch: "arm64",
  artifactName: DMG,
  artifactSha256: DIGEST,
  recordIds: [certified.id],
  sourceCommit: TAG_COMMIT,
  checks: Object.fromEntries(
    INTEGRATION_ACCEPTANCE_CHECKS["codex-chrome"].map((check) => [check.id, true]),
  ),
};
const ACCEPTANCE_PATH =
  "docs/computer-certification/acceptance-1.2.3-codex-chrome-darwin-arm64.json";

function fake(patch: {
  records?: unknown[];
  acceptance?: IntegrationAcceptanceReport | null;
  /** More acceptance reports on main, by path. */
  reports?: Record<string, IntegrationAcceptanceReport>;
  digest?: string;
  digests?: Record<string, string>;
  isDraft?: boolean;
  ancestor?: boolean;
  assets?: string[];
}) {
  const downloads: string[] = [];
  const io: PromotionIo = {
    show: (revision, path) => {
      // Records are only ever read at the remote tag's commit.
      if (revision === TAG_COMMIT && path.endsWith("codex-chrome.generated.json"))
        return JSON.stringify(patch.records ?? [certified]);
      if (revision === TAG_COMMIT && path.endsWith(".generated.json")) return "[]";
      if (revision !== "origin/main") return undefined;
      if (path === ACCEPTANCE_PATH && patch.acceptance !== null)
        return JSON.stringify(patch.acceptance ?? acceptance);
      const extra = patch.reports?.[path];
      return extra && JSON.stringify(extra);
    },
    commitOf: () => TAG_COMMIT,
    isAncestor: () => patch.ancestor ?? true,
    release: () => ({
      isDraft: patch.isDraft ?? true,
      assets: patch.assets ?? [DMG, "latest-mac.yml"],
    }),
    assetSha256: (_tag, name) => {
      downloads.push(name);
      return patch.digests?.[name] ?? patch.digest ?? DIGEST;
    },
  };
  return { io, downloads };
}

describe("release promotion", () => {
  it("promotes when acceptance covers the exact artifact and records", () => {
    const { io, downloads } = fake({});
    expect(promotionProblems(TAG, io)).toEqual([]);
    expect(downloads).toEqual([DMG]);
  });

  it("only checks the draft state when nothing is certified", () => {
    const { io, downloads } = fake({ records: [base] });
    expect(promotionProblems(TAG, io)).toEqual([]);
    expect(downloads).toEqual([]);
    expect(promotionProblems(TAG, fake({ records: [base], isDraft: false }).io)).toEqual([
      `${TAG} is already published.`,
    ]);
  });

  it("refuses a different artifact", () => {
    expect(promotionProblems(TAG, fake({ digest: "e".repeat(64) }).io)).toEqual([
      "codex-chrome darwin-arm64: artifactSha256",
    ]);
  });

  it("refuses a missing acceptance report or a missing DMG", () => {
    expect(promotionProblems(TAG, fake({ acceptance: null }).io)).toEqual([
      `codex-chrome darwin-arm64: no acceptance report ${ACCEPTANCE_PATH} on origin/main`,
    ]);
    expect(promotionProblems(TAG, fake({ assets: ["latest-mac.yml"] }).io)).toEqual([
      `codex-chrome darwin-arm64: the draft has no ${DMG}`,
    ]);
  });

  it("refuses a failed check", () => {
    const failed = { ...acceptance, checks: { ...acceptance.checks, "idle-stop": false } };
    expect(promotionProblems(TAG, fake({ acceptance: failed }).io)).toEqual([
      "codex-chrome darwin-arm64: check idle-stop",
    ]);
  });

  it("refuses acceptance that doesn't cover every certifying record", () => {
    const second = { ...certified, id: "codex-chrome-darwin-arm64-26.1030.1" };
    expect(promotionProblems(TAG, fake({ records: [certified, second] }).io)).toEqual([
      "codex-chrome darwin-arm64: recordIds",
    ]);
  });

  it("refuses acceptance of another tag's build or commit", () => {
    expect(
      promotionProblems(
        TAG,
        fake({ acceptance: { ...acceptance, sourceCommit: "3".repeat(40) } }).io,
      ),
    ).toEqual(["codex-chrome darwin-arm64: sourceCommit"]);
    expect(
      promotionProblems(TAG, fake({ acceptance: { ...acceptance, tag: "v1.2.2" } }).io),
    ).toEqual(["codex-chrome darwin-arm64: tag"]);
  });

  it("refuses a record whose evidence commit is not in the tag's history", () => {
    expect(promotionProblems(TAG, fake({ ancestor: false }).io)).toEqual([
      `${certified.id}: evidence commit is not in ${TAG}'s history`,
    ]);
  });

  it("promotes arm64 and x64 from their own acceptance reports", () => {
    const x64Dmg = "F5-1.2.3-x64.dmg";
    const x64 = { ...certified, id: "codex-chrome-darwin-x64-26.1020.5", arch: "x64" };
    const x64Report: IntegrationAcceptanceReport = {
      ...acceptance,
      arch: "x64",
      artifactName: x64Dmg,
      artifactSha256: "e".repeat(64),
      recordIds: [x64.id],
    };
    const { io, downloads } = fake({
      records: [certified, x64],
      assets: [DMG, x64Dmg],
      digests: { [x64Dmg]: "e".repeat(64) },
      reports: {
        "docs/computer-certification/acceptance-1.2.3-codex-chrome-darwin-x64.json": x64Report,
      },
    });
    expect(promotionProblems(TAG, io)).toEqual([]);
    expect(downloads.sort()).toEqual([DMG, x64Dmg]);
    // Without the x64 report, only that target is refused.
    expect(
      promotionProblems(TAG, fake({ records: [certified, x64], assets: [DMG, x64Dmg] }).io),
    ).toEqual([
      "codex-chrome darwin-x64: no acceptance report docs/computer-certification/acceptance-1.2.3-codex-chrome-darwin-x64.json on origin/main",
    ]);
  });

  it("uses the same required assertions the stamper does", () => {
    expect(INTEGRATION_REQUIRED_ASSERTIONS["codex-chrome"]).toContain(
      "background-work-stops-on-pause",
    );
  });
});

describe("remote tag commit", () => {
  const sha = (char: string) => char.repeat(40);
  const git = (remote: string, local: string) => ({ remote: () => remote, local: () => local });
  it("peels annotated tags and requires the local tag to match", () => {
    const annotated = `${sha("a")}\trefs/tags/${TAG}\n${sha("b")}\trefs/tags/${TAG}^{}\n`;
    expect(remoteTagCommit(TAG, git(annotated, sha("b")))).toBe(sha("b"));
    expect(remoteTagCommit(TAG, git(`${sha("c")}\trefs/tags/${TAG}\n`, sha("c")))).toBe(sha("c"));
    expect(() => remoteTagCommit(TAG, git(annotated, sha("d")))).toThrow("differs from origin");
    expect(() => remoteTagCommit(TAG, git("", sha("b")))).toThrow(`origin has no tag ${TAG}`);
  });
});
