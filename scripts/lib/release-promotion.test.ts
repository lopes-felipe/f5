import { describe, expect, it } from "vitest";
import {
  CODEX_CHROME_DRAIN_TOOL,
  INTEGRATION_REQUIRED_ASSERTIONS,
  PROVIDER_INTEGRATION_RECORDS,
  type CodexChromeRecord,
} from "@t3tools/shared/providerIntegrationCertification";
import {
  draftSourceCommit,
  promotionProblems,
  promotionSource,
  remoteTagCommit,
  type PromotionIo,
} from "./release-promotion.ts";

const TAG = "v1.2.3";
const TAG_COMMIT = "1".repeat(40);
const EVIDENCE_COMMIT = "2".repeat(40);
const base = PROVIDER_INTEGRATION_RECORDS["codex-chrome"][0]!;
const certified: CodexChromeRecord = {
  ...base,
  id: "codex-chrome-darwin-arm64-26.1020.5",
  evidenceId: "evidence",
  versions: { ...base.versions, codexMin: "0.163.0" },
  evidenceCommit: EVIDENCE_COMMIT,
  toolNames: [...base.identity.allowedTools, CODEX_CHROME_DRAIN_TOOL],
  toolInventorySha256: "d".repeat(64),
  identity: { ...base.identity, admission: "session" },
};
function fake(patch: { records?: unknown[]; isDraft?: boolean; ancestor?: boolean }) {
  const reads: string[] = [];
  const io: PromotionIo = {
    show: (revision, path) => {
      reads.push(`${revision}:${path}`);
      // Records are only ever read at the remote tag's commit.
      if (revision === TAG_COMMIT && path.endsWith("codex-chrome.generated.json"))
        return JSON.stringify(patch.records ?? [certified]);
      if (revision === TAG_COMMIT && path.endsWith(".generated.json")) return "[]";
      return undefined;
    },
    commitOf: () => TAG_COMMIT,
    isAncestor: () => patch.ancestor ?? true,
    release: () => ({ isDraft: patch.isDraft ?? true }),
  };
  return { io, reads };
}

describe("release promotion", () => {
  it("promotes a certifying draft without any acceptance report", () => {
    const { io, reads } = fake({});
    expect(promotionProblems(TAG, io)).toEqual([]);
    expect(reads.every((read) => read.startsWith(`${TAG_COMMIT}:`))).toBe(true);
  });

  it("only checks the draft state when nothing is certified", () => {
    expect(promotionProblems(TAG, fake({ records: [base] }).io)).toEqual([]);
    expect(promotionProblems(TAG, fake({ records: [base], isDraft: false }).io)).toEqual([
      `${TAG} is already published.`,
    ]);
  });

  it("refuses a record whose evidence commit is not in the tag's history", () => {
    expect(promotionProblems(TAG, fake({ ancestor: false }).io)).toEqual([
      `${certified.id}: evidence commit is not in ${TAG}'s history`,
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

describe("draft source commit", () => {
  it("reads only a full SHA from a draft", () => {
    expect(draftSourceCommit({ draft: true, target_commitish: "a".repeat(40) })).toBe(
      "a".repeat(40),
    );
    // Legacy drafts name a branch; published releases are identified by their tag.
    expect(draftSourceCommit({ draft: true, target_commitish: "main" })).toBeUndefined();
    expect(draftSourceCommit({ draft: true, target_commitish: "A".repeat(40) })).toBeUndefined();
    expect(draftSourceCommit({ draft: true })).toBeUndefined();
    expect(draftSourceCommit({ draft: false, target_commitish: "a".repeat(40) })).toBeUndefined();
  });
});

describe("promotion source", () => {
  const io = (tag: boolean, release: { draft: boolean; target_commitish?: string }) => ({
    tagExists: () => tag,
    remoteTagCommit: () => "b".repeat(40),
    release: () => release,
  });
  it("trusts an existing remote tag over the draft's target", () => {
    expect(
      promotionSource(TAG, io(true, { draft: true, target_commitish: "a".repeat(40) })),
    ).toEqual({ commit: "b".repeat(40), needsTag: false });
  });
  it("promotes a tagless draft from its target and asks for the tag", () => {
    expect(
      promotionSource(TAG, io(false, { draft: true, target_commitish: "a".repeat(40) })),
    ).toEqual({ commit: "a".repeat(40), needsTag: true });
  });
  it("refuses a tagless release without a full source SHA", () => {
    expect(() =>
      promotionSource(TAG, io(false, { draft: true, target_commitish: "main" })),
    ).toThrow(`origin has no tag ${TAG}`);
    expect(() =>
      promotionSource(TAG, io(false, { draft: false, target_commitish: "a".repeat(40) })),
    ).toThrow(`origin has no tag ${TAG}`);
  });
});
