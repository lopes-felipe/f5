import { readFileSync } from "node:fs";

import type { UpstreamTopic } from "@t3tools/contracts";
import { parseRules, type Rules } from "@t3tools/shared/upstreamPorts";

import type { ChunkCommit } from "./triage.ts";

/** The repository's seed rules, so tests track `upstream/rules.json`. */
export const SEED_RULES: Rules = (() => {
  const parsed = parseRules(
    readFileSync(new URL("../../../../upstream/rules.json", import.meta.url), "utf8"),
  );
  if (parsed.errors.length || !parsed.rules) throw new Error(parsed.errors.join("; "));
  return parsed.rules;
})();

/** Deterministic 40-hex SHA whose 12-char prefix is unique per `n`. */
export const sha = (n: number, fill = "a") =>
  `${n.toString(16).padStart(8, "0")}${fill.repeat(32)}`;

export function chunkCommit(input: {
  readonly sha: string;
  readonly subject?: string;
  readonly paths?: ReadonlyArray<string>;
  readonly body?: string;
  readonly pr?: number | null;
}): ChunkCommit {
  const paths = input.paths ?? ["apps/server/src/feature.ts"];
  const subject = input.subject ?? `Change ${input.sha.slice(0, 7)}`;
  return {
    sha: input.sha,
    subject,
    body: input.body ?? "",
    pr: input.pr ?? null,
    paths,
    digest: {
      sha: input.sha,
      subject,
      pr: input.pr ?? null,
      parentCount: 1,
      files: paths.map((path) => ({ path, added: 1, deleted: 0, existsInFork: true })),
      totalFiles: paths.length,
      excerpt: "",
      prBody: null,
      hints: [],
    },
  };
}

export function topic(
  overrides: Partial<UpstreamTopic> & Pick<UpstreamTopic, "id">,
): UpstreamTopic {
  return {
    createdAt: "2026-10-01T00:00:00.000Z",
    title: `Topic ${overrides.id}`,
    summary: "",
    upstreamPrs: [],
    status: "inbox",
    epoch: 1,
    ...overrides,
  };
}
