import {
  acceptanceMismatches,
  recordCertifies,
  type IntegrationAcceptanceReport,
  type ProviderIntegration,
  type ProviderIntegrationRecord,
} from "@t3tools/shared/providerIntegrationCertification";
import { acceptanceReportPath, macArtifactName } from "./integration-acceptance.ts";

const INTEGRATIONS: ReadonlyArray<ProviderIntegration> = [
  "claude-chrome",
  "codex-chrome",
  "codex-computer",
];

export interface PromotionIo {
  /** File contents at a git revision, or undefined when the path doesn't exist there. */
  readonly show: (revision: string, path: string) => string | undefined;
  readonly commitOf: (revision: string) => string;
  readonly isAncestor: (commit: string, revision: string) => boolean;
  readonly release: (tag: string) => {
    readonly isDraft: boolean;
    readonly assets: ReadonlyArray<string>;
  };
  /** sha256 of a release asset, downloaded from the draft itself. */
  readonly assetSha256: (tag: string, name: string) => string;
}

/**
 * Everything that must hold before a draft is published. A release that embeds a
 * certifying record needs, per integration and target, an all-passed acceptance report
 * on `acceptedOn` (main) for this tag's exact artifact; every record's evidence commit
 * must be in the tag's history. With no certifying record, only the draft state matters.
 */
export function promotionProblems(
  tag: string,
  io: PromotionIo,
  acceptedOn = "origin/main",
): string[] {
  const problems: string[] = [];
  const release = io.release(tag);
  if (!release.isDraft) return [`${tag} is already published.`];
  const version = tag.replace(/^v/, "");
  // Records are read at the commit the remote tag names: the draft was built from it.
  const tagCommit = io.commitOf(tag);
  const digests = new Map<string, string>();
  for (const integration of INTEGRATIONS) {
    const text = io.show(
      tagCommit,
      `packages/shared/src/certification/${integration}.generated.json`,
    );
    const records = (text ? JSON.parse(text) : []) as ProviderIntegrationRecord[];
    const certifying = records.filter(recordCertifies);
    if (!certifying.length) continue;
    for (const record of certifying)
      if (!io.isAncestor(record.evidenceCommit!, tagCommit))
        problems.push(`${record.id}: evidence commit is not in ${tag}'s history`);
    const targets = new Map<string, ProviderIntegrationRecord[]>();
    for (const record of certifying) {
      const key = `${record.platform}-${record.arch}`;
      targets.set(key, [...(targets.get(key) ?? []), record]);
    }
    for (const [target, group] of targets) {
      const { platform, arch } = group[0]!;
      if (platform !== "darwin") {
        problems.push(`${integration} ${target}: acceptance is macOS only`);
        continue;
      }
      const artifactName = macArtifactName(version, arch);
      if (!release.assets.includes(artifactName)) {
        problems.push(`${integration} ${target}: the draft has no ${artifactName}`);
        continue;
      }
      const path = acceptanceReportPath(version, integration, platform, arch);
      const reportText = io.show(acceptedOn, path);
      if (!reportText) {
        problems.push(`${integration} ${target}: no acceptance report ${path} on ${acceptedOn}`);
        continue;
      }
      const report = JSON.parse(reportText) as IntegrationAcceptanceReport;
      if (!digests.has(artifactName)) digests.set(artifactName, io.assetSha256(tag, artifactName));
      const mismatches = acceptanceMismatches(report, {
        integration,
        tag,
        artifactSha256: digests.get(artifactName)!,
        recordIds: group.map((record) => record.id),
      });
      if (report.platform !== platform || report.arch !== arch) mismatches.push("target");
      if (report.artifactName !== artifactName) mismatches.push("artifactName");
      if (report.sourceCommit !== tagCommit) mismatches.push("sourceCommit");
      for (const mismatch of mismatches) problems.push(`${integration} ${target}: ${mismatch}`);
    }
  }
  return problems;
}

/**
 * The commit `refs/tags/<tag>` names on the remote (peeled for annotated tags). A local
 * tag that differs is refused rather than trusted: it may be stale or moved.
 */
export function remoteTagCommit(
  tag: string,
  git: { readonly local: (tag: string) => string; readonly remote: (tag: string) => string },
): string {
  const refs = new Map(
    git
      .remote(tag)
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((parts): parts is [string, string] => parts.length === 2)
      .map(([sha, ref]) => [ref, sha]),
  );
  const commit = refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`);
  if (!commit || !/^[a-f0-9]{40}$/.test(commit)) throw new Error(`origin has no tag ${tag}.`);
  const local = git.local(tag);
  if (local !== commit)
    throw new Error(`Local tag ${tag} (${local}) differs from origin's (${commit}). Refetch it.`);
  return commit;
}
