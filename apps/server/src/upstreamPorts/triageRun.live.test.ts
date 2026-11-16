/**
 * Calibration (plan §4.6): one real 20-commit triage batch through the
 * production prompt, Claude isolation and output validation. Skipped unless
 * `F5_UPSTREAM_TRIAGE_LIVE=1`; needs a signed-in `claude` CLI and an
 * `upstream` remote in this checkout.
 *
 *   F5_UPSTREAM_TRIAGE_LIVE=1 [F5_UPSTREAM_TRIAGE_MODEL=claude-sonnet-5-5] \
 *     node node_modules/vitest/vitest.mjs run apps/server/src/upstreamPorts/triageRun.live.test.ts
 */
import { execFileSync } from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ClaudeSettings, ProviderInstanceId, UpstreamTriageBatchResult } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { prNumberFromSubject } from "@t3tools/shared/upstreamPorts";
import { Effect, Layer, Schema, Semaphore } from "effect";
import { expect } from "vitest";

import { ServerConfig } from "../config.ts";
import { makeClaudeTextGeneration } from "../git/Layers/ClaudeTextGeneration.ts";
import { SEED_RULES } from "./testFixtures.ts";
import { DEFAULT_BATCH_SIZE, triageChunk, type ChunkCommit } from "./triage.ts";

const live = process.env.F5_UPSTREAM_TRIAGE_LIVE === "1";
const layer = ServerConfig.layerTest(process.cwd(), { prefix: "f5-upstream-triage-live-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const git = (args: ReadonlyArray<string>) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function recentUpstreamCommits(count: number): ChunkCommit[] {
  const log = git([
    "log",
    "--first-parent",
    `-${count}`,
    "--format=%H%x1f%s%x1f%P%x1e",
    "refs/remotes/upstream/main",
  ]);
  return log
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, subject, parents] = entry.split("\x1f") as [string, string, string];
      const paths = git(["show", "--format=", "--name-only", "--diff-merges=first-parent", sha])
        .split("\n")
        .filter(Boolean);
      const pr = prNumberFromSubject(subject);
      return {
        sha,
        subject,
        body: "",
        pr,
        paths,
        digest: {
          sha,
          subject,
          pr,
          parentCount: parents.split(" ").length,
          files: paths
            .slice(0, 15)
            .map((path) => ({ path, added: null, deleted: null, existsInFork: false })),
          totalFiles: paths.length,
          excerpt: git([
            "show",
            "--format=",
            "--unified=1",
            "--no-color",
            "--diff-merges=first-parent",
            sha,
          ]).slice(0, 1_200),
          prBody: null,
          hints: [],
        },
      };
    })
    .toReversed();
}

it.live.skipIf(!live)(
  "upstream triage calibration: one batch with valid output",
  () =>
    Effect.gen(function* () {
      const commits = recentUpstreamCommits(DEFAULT_BATCH_SIZE);
      const generation = yield* makeClaudeTextGeneration(
        Schema.decodeSync(ClaudeSettings)({}),
        process.env,
      );
      const model = process.env.F5_UPSTREAM_TRIAGE_MODEL ?? "claude-sonnet-5-5";
      const started = Date.now();
      let calls = 0;
      const result = yield* triageChunk({
        repository: "https://github.com/pingdotgg/t3code",
        policy: execFileSync("git", ["show", "HEAD:upstream/policy.md"], { encoding: "utf8" }),
        rules: SEED_RULES,
        model,
        commits,
        prior: new Map(),
        openTopics: [],
        attachable: new Set(),
        semaphore: Semaphore.makeUnsafe(1),
        triage: (prompt) => {
          calls += 1;
          return generation.generateStructuredJson({
            cwd: process.cwd(),
            operation: "upstreamTriage",
            prompt,
            outputSchema: UpstreamTriageBatchResult,
            modelSelection: createModelSelection(ProviderInstanceId.make("claudeAgent"), model),
            isolation: "no-workspace",
          });
        },
      });
      const seconds = (Date.now() - started) / 1_000;
      const fallbacks = result.groups.filter((group) => group.suggestion?.triageError).length;
      console.log(
        JSON.stringify({
          model,
          commits: commits.length,
          calls,
          seconds,
          groups: result.groups.length,
          fallbacks,
        }),
      );
      expect(result.groups.flatMap((group) => group.commits).toSorted()).toEqual(
        commits.map((commit) => commit.sha).toSorted(),
      );
      expect(fallbacks).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  600_000,
);
