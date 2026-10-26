/**
 * Upstream triage for one chunk of commits: deterministic rules first
 * (path rules, legacy equivalence, the revert table), then tool-less LLM
 * batches in waves, then auto-decide. The output is new topics plus the
 * membership of every chunk commit; recording happens in the service.
 *
 * @module upstreamPorts/triage
 */
import {
  UPSTREAM_SUGGESTION_AREAS_MAX,
  UPSTREAM_SUGGESTION_QUESTION_MAX,
  UPSTREAM_SUGGESTION_REASON_MAX,
  UPSTREAM_TOPIC_SUMMARY_MAX,
  UPSTREAM_TOPIC_TITLE_MAX,
  type UpstreamSuggestionStatus,
  type UpstreamTopic,
  type UpstreamTopicState,
  type UpstreamTopicSuggestion,
  type UpstreamTriageBatchResult,
  type UpstreamUserImpact,
} from "@t3tools/contracts";
import {
  buildRevertChains,
  isValidReasonKey,
  matchAutoSkipRule,
  reasonLabel,
  topicIdFor,
  type Rules,
} from "@t3tools/shared/upstreamPorts";
import {
  buildTriageBatchPrompt,
  type TriageCommitDigest,
  type TriageTopicRow,
} from "@t3tools/shared/upstreamPortsPrompts";
import { Effect, Ref, Semaphore } from "effect";

import type { TextGenerationError } from "../git/Errors.ts";

export const DEFAULT_BATCH_SIZE = 20;
export const WAVE_CONCURRENCY = 3;
export const PROVIDER_FAILURE_LIMIT = 3;
export const LEGACY_EQUIVALENT_CONFIDENCE = 0.7;

/** Shared across projects: at most three triage calls in flight per server. */
export const globalTriageSemaphore = Semaphore.makeUnsafe(WAVE_CONCURRENCY);

export interface ChunkCommit {
  readonly sha: string;
  readonly subject: string;
  readonly body: string;
  readonly pr: number | null;
  /** Every changed path (uncapped). */
  readonly paths: ReadonlyArray<string>;
  readonly digest: TriageCommitDigest;
}

/** What the view knows about a commit outside this chunk (for revert targets). */
export type PriorCommit =
  | {
      readonly kind: "topic";
      readonly topicId: string;
      readonly state: UpstreamTopicState;
      readonly status: UpstreamTopic["status"];
      readonly paths: ReadonlyArray<string> | null;
    }
  | {
      readonly kind: "archive";
      readonly disposition: string;
      readonly subject: string;
      readonly paths: ReadonlyArray<string> | null;
    };

export type GroupDecision = {
  readonly status: "skip";
  readonly reasonKey: string;
  readonly reason: string;
  readonly decidedBy: "rule" | "llm";
};

export interface DraftGroup {
  readonly key: string;
  /** Chronological (oldest first). */
  commits: string[];
  /** Existing view topic to join (inbox or watch only); null creates a new topic. */
  attachTo: string | null;
  related: string[];
  title: string;
  summary: string;
  suggestion: UpstreamTopicSuggestion | null;
  decision: GroupDecision | null;
  revertChain: boolean;
}

export type TriageCall = (
  prompt: string,
) => Effect.Effect<UpstreamTriageBatchResult, TextGenerationError>;

export interface TriageChunkInput {
  readonly repository: string;
  readonly policy: string;
  readonly rules: Rules;
  readonly model: string;
  /** Chronological (oldest first). */
  readonly commits: ReadonlyArray<ChunkCommit>;
  /** Commits outside the chunk that a revert may target. */
  readonly prior: ReadonlyMap<string, PriorCommit>;
  readonly openTopics: ReadonlyArray<TriageTopicRow>;
  /** Topic ids that accept follow-ups (derived inbox or watch). */
  readonly attachable: ReadonlySet<string>;
  /** Pre-built groups (legacy equivalence), excluded from rules and the LLM. */
  readonly presetGroups?: ReadonlyArray<DraftGroup>;
  /** null runs rules only. */
  readonly triage: TriageCall | null;
  readonly batchSize?: number;
  readonly concurrency?: number;
  readonly semaphore?: Semaphore.Semaphore;
  /** Consecutive provider failures, shared across a run's chunks. */
  readonly circuit?: { consecutiveFailures: number };
  /**
   * The run's remaining LLM calls and its deadline, checked before every
   * batch and retry. Commits whose batch would exceed either fall back to the inbox.
   */
  readonly budget?: {
    readonly calls: number;
    readonly deadlineAt: number;
    readonly now: () => number;
  };
}

export interface TriageChunkResult {
  readonly groups: ReadonlyArray<DraftGroup>;
  readonly llmCalls: number;
  readonly policyTruncated: boolean;
}

export class ProviderUnavailableError extends Error {
  constructor(
    readonly detail: string,
    /** Calls the chunk made before the circuit opened. */
    readonly llmCalls = 0,
  ) {
    super(`Triage provider unavailable: ${detail}`);
    this.name = "ProviderUnavailableError";
  }
}

const truncate = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;

const oneLine = (text: string) => text.replace(/\s+/gu, " ").trim();

const CONSERVATIVE_ORDER: Record<UpstreamSuggestionStatus, number> = {
  port: 0,
  equivalent: 1,
  watch: 2,
  skip: 3,
};

export function moreConservative(
  a: UpstreamTopicSuggestion,
  b: UpstreamTopicSuggestion,
): UpstreamTopicSuggestion {
  return CONSERVATIVE_ORDER[a.status] <= CONSERVATIVE_ORDER[b.status] ? a : b;
}

/**
 * Combines two suggestions for one topic. The more conservative status wins,
 * and every source of doubt survives: the lower confidence, any question or
 * triage error, and a conflict when the statuses differ.
 */
export function mergeSuggestions(
  a: UpstreamTopicSuggestion,
  b: UpstreamTopicSuggestion,
): UpstreamTopicSuggestion {
  const kept = moreConservative(a, b);
  const other = kept === a ? b : a;
  const question = kept.question ?? other.question;
  const triageError = kept.triageError ?? other.triageError;
  return {
    ...kept,
    confidence: Math.min(a.confidence, b.confidence),
    ...(question !== undefined ? { question } : {}),
    ...(triageError !== undefined ? { triageError } : {}),
    ...(a.status !== b.status || a.conflict || b.conflict ? { conflict: true as const } : {}),
  };
}

function inboxFallback(commit: ChunkCommit, model: string, triageError: string): DraftGroup {
  return {
    key: `commit:${commit.sha}`,
    commits: [commit.sha],
    attachTo: null,
    related: [],
    title: truncate(oneLine(commit.subject) || commit.sha.slice(0, 12), UPSTREAM_TOPIC_TITLE_MAX),
    summary: "",
    suggestion: {
      status: "port",
      reason: "Triage did not classify this commit; review it manually.",
      userImpact: "medium",
      confidence: 0,
      areas: [],
      model,
      triageError,
    },
    decision: null,
    revertChain: false,
  };
}

function plainGroup(commit: ChunkCommit): DraftGroup {
  return {
    key: `commit:${commit.sha}`,
    commits: [commit.sha],
    attachTo: null,
    related: [],
    title: truncate(oneLine(commit.subject) || commit.sha.slice(0, 12), UPSTREAM_TOPIC_TITLE_MAX),
    summary: "",
    suggestion: null,
    decision: null,
    revertChain: false,
  };
}

function ruleSkip(
  commits: ReadonlyArray<ChunkCommit>,
  rules: Rules,
  reasonKey: string,
  reason?: string,
): DraftGroup {
  const first = commits[0]!;
  return {
    key: `rule:${first.sha}`,
    commits: commits.map((commit) => commit.sha),
    attachTo: null,
    related: [],
    title: truncate(oneLine(first.subject) || first.sha.slice(0, 12), UPSTREAM_TOPIC_TITLE_MAX),
    summary: "",
    suggestion: null,
    decision: {
      status: "skip",
      reasonKey,
      reason: reason ?? reasonLabel(rules, reasonKey),
      decidedBy: "rule",
    },
    revertChain: commits.length > 1,
  };
}

const samePaths = (a: ReadonlyArray<string>, b: ReadonlyArray<string> | null) =>
  b !== null && a.length === b.length && new Set([...a, ...b]).size === a.length;

export interface RevertPlan {
  /** Groups fully decided by rules (or attachments to an existing topic). */
  readonly decided: ReadonlyArray<DraftGroup>;
  /** Commit sets that must go to the LLM together, with prompt hints. */
  readonly llmChains: ReadonlyArray<{
    readonly shas: ReadonlyArray<string>;
    readonly hint: string;
  }>;
  /** Per-commit hints for single reverts sent to the LLM. */
  readonly hints: ReadonlyMap<string, string>;
  /** Chain members handled here (excluded from path rules). */
  readonly handled: ReadonlySet<string>;
}

/** Applies the revert table (plan §4.5) to a chronological chunk. */
export function planReverts(
  commits: ReadonlyArray<ChunkCommit>,
  prior: ReadonlyMap<string, PriorCommit>,
  attachable: ReadonlySet<string>,
  rules: Rules,
): RevertPlan {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const chains = buildRevertChains(
    commits.map((commit) => ({ sha: commit.sha, body: commit.body, paths: commit.paths })),
    (sha) => prior.get(sha)?.paths ?? null,
  );
  const decided: DraftGroup[] = [];
  const llmChains: Array<{ shas: string[]; hint: string }> = [];
  const hints = new Map<string, string>();
  const handled = new Set<string>();
  const chainPrefix = (netEffect: string) => `Revert chain, net effect: ${netEffect}`;
  for (const chain of chains) {
    for (const sha of chain.members) handled.add(sha);
    const members = chain.members.map((sha) => bySha.get(sha)!).filter(Boolean);
    if (chain.rootInRun) {
      if (chain.depth === 1 && chain.full) {
        decided.push(
          ruleSkip(members, rules, "reverted", "Reverted upstream within the same range"),
        );
      } else {
        llmChains.push({ shas: [...chain.members], hint: chainPrefix(chain.netEffect) });
      }
      continue;
    }
    const target = prior.get(chain.root);
    const first = members[0]!;
    const targetPaths = target?.paths ?? null;
    const full = chain.depth === 1 && samePaths(first.paths, targetPaths);
    if (chain.depth > 1) {
      llmChains.push({ shas: [...chain.members], hint: chainPrefix(chain.netEffect) });
      continue;
    }
    if (!target) {
      hints.set(first.sha, `reverts an unknown commit ${chain.root.slice(0, 7)}`);
      handled.delete(first.sha);
      continue;
    }
    if (target.kind === "topic") {
      if (attachable.has(target.topicId)) {
        decided.push({
          ...plainGroup(first),
          key: `attach:${first.sha}`,
          attachTo: target.topicId,
          revertChain: true,
        });
      } else if (target.state === "done" || target.status === "port") {
        decided.push({
          ...plainGroup(first),
          key: `revert:${first.sha}`,
          related: [target.topicId],
          revertChain: true,
          suggestion: {
            status: "port",
            reason: "Upstream reverted a change f5 ported or plans to port",
            userImpact: "high",
            confidence: 1,
            areas: [],
            model: "rule",
          },
        });
      } else if ((target.status === "skip" || target.status === "declined") && full) {
        decided.push({
          ...ruleSkip([first], rules, "reverted", "Reverts an upstream change f5 skipped"),
          related: [target.topicId],
        });
      } else {
        hints.set(first.sha, `reverts ${target.topicId}, which f5 marked ${target.status}`);
        handled.delete(first.sha);
      }
      continue;
    }
    if (["ported", "equivalent", "already-present"].includes(target.disposition)) {
      decided.push({
        ...plainGroup(first),
        key: `revert:${first.sha}`,
        revertChain: true,
        suggestion: {
          status: "port",
          reason: "Upstream reverted a change f5 ported or plans to port",
          userImpact: "high",
          confidence: 1,
          areas: [],
          model: "rule",
        },
      });
    } else if (["not-applicable", "declined"].includes(target.disposition) && full) {
      decided.push(
        ruleSkip([first], rules, "reverted", "Reverts an upstream change f5 did not take"),
      );
    } else {
      hints.set(
        first.sha,
        target.disposition === "deferred"
          ? `reverts archived deferred change ${chain.root.slice(0, 7)}: ${target.subject}`
          : `reverts archived ${target.disposition} change ${chain.root.slice(0, 7)}: ${target.subject}`,
      );
      handled.delete(first.sha);
    }
  }
  return { decided, llmChains, hints, handled };
}

/** Chronological batches of about `size` commits; revert chains stay in one batch. */
export function batchCommits(
  units: ReadonlyArray<ReadonlyArray<string>>,
  size: number,
): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  for (const unit of units) {
    if (current.length > 0 && current.length + unit.length > size) {
      batches.push(current);
      current = [];
    }
    current.push(...unit);
  }
  if (current.length) batches.push(current);
  return batches;
}

export interface ValidatedBatch {
  readonly groups: ReadonlyArray<{
    readonly key: string;
    readonly commits: ReadonlyArray<string>;
    readonly attachTo: string | null;
    readonly relatedTo: string | null;
    readonly title: string;
    readonly summary: string;
    readonly suggestion: UpstreamTopicSuggestion;
  }>;
  readonly omitted: ReadonlyArray<string>;
}

/** Every input SHA exactly once (full SHA or unique 12-char prefix); duplicates keep the first. */
export function validateBatchOutput(
  input: ReadonlyArray<string>,
  output: UpstreamTriageBatchResult,
  rules: Rules,
  model: string,
): ValidatedBatch {
  const wanted = new Set(input);
  const byPrefix = new Map<string, string | null>();
  for (const sha of input) {
    const prefix = sha.slice(0, 12);
    byPrefix.set(prefix, byPrefix.has(prefix) ? null : sha);
  }
  const resolve = (value: string): string | null => {
    const text = value.trim().toLowerCase();
    if (wanted.has(text)) return text;
    if (text.length >= 12) {
      const match = byPrefix.get(text.slice(0, 12));
      if (match && match.startsWith(text)) return match;
    }
    return null;
  };
  const seen = new Set<string>();
  const groups: Array<ValidatedBatch["groups"][number]> = [];
  output.groups.forEach((group, index) => {
    const commits: string[] = [];
    for (const value of group.commits) {
      const sha = resolve(value);
      if (sha === null || seen.has(sha)) continue;
      seen.add(sha);
      commits.push(sha);
    }
    if (commits.length === 0) return;
    const ordered = input.filter((sha) => commits.includes(sha));
    const reasonKey =
      group.suggestion === "skip" && group.reasonKey && isValidReasonKey(rules, group.reasonKey)
        ? group.reasonKey
        : undefined;
    const question = group.question?.trim();
    groups.push({
      key: group.key?.trim() || `group-${index}`,
      commits: ordered,
      attachTo: group.attachTo?.trim() || null,
      relatedTo: group.relatedTo?.trim() || null,
      title: truncate(oneLine(group.title) || ordered[0]!.slice(0, 12), UPSTREAM_TOPIC_TITLE_MAX),
      summary: truncate(oneLine(group.summary ?? ""), UPSTREAM_TOPIC_SUMMARY_MAX),
      suggestion: {
        status: group.suggestion,
        ...(reasonKey ? { reasonKey } : {}),
        reason: truncate(oneLine(group.reason ?? ""), UPSTREAM_SUGGESTION_REASON_MAX),
        userImpact: (["high", "medium", "low", "none"] as const).includes(
          group.userImpact as UpstreamUserImpact,
        )
          ? group.userImpact
          : "medium",
        confidence: Number.isFinite(group.confidence)
          ? Math.min(1, Math.max(0, group.confidence))
          : 0,
        areas: group.areas
          .map((area) => truncate(oneLine(area), 40))
          .filter(Boolean)
          .slice(0, UPSTREAM_SUGGESTION_AREAS_MAX),
        model,
        ...(question
          ? { question: truncate(oneLine(question), UPSTREAM_SUGGESTION_QUESTION_MAX) }
          : {}),
        // An unknown reason key keeps the reason but becomes ineligible for auto-skip.
        ...(group.suggestion === "skip" && !reasonKey && group.reasonKey
          ? { triageError: `unknown reason key ${group.reasonKey}` }
          : {}),
      },
    });
  });
  return { groups, omitted: input.filter((sha) => !seen.has(sha)) };
}

export function autoDecision(
  group: Pick<DraftGroup, "suggestion" | "revertChain">,
  rules: Rules,
): GroupDecision | null {
  const suggestion = group.suggestion;
  if (
    !suggestion ||
    group.revertChain ||
    suggestion.status !== "skip" ||
    !suggestion.reasonKey ||
    !isValidReasonKey(rules, suggestion.reasonKey) ||
    suggestion.conflict ||
    suggestion.question ||
    suggestion.triageError ||
    suggestion.confidence < rules.autoSkipConfidence
  )
    return null;
  return {
    status: "skip",
    reasonKey: suggestion.reasonKey,
    reason: suggestion.reason || reasonLabel(rules, suggestion.reasonKey),
    decidedBy: "llm",
  };
}

const PROVIDER_KINDS = new Set([
  "unavailable",
  "auth",
  "limit",
  "generic",
  "unsupported",
  undefined,
]);
const isBatchFailure = (error: TextGenerationError) =>
  error.kind === "timeout" || error.kind === "invalid-output";

/** Runs rules, then LLM waves, for one chunk. Fails with ProviderUnavailableError when the circuit opens. */
export function triageChunk(
  input: TriageChunkInput,
): Effect.Effect<TriageChunkResult, ProviderUnavailableError> {
  return Effect.gen(function* () {
    const { rules, model } = input;
    const bySha = new Map(input.commits.map((commit) => [commit.sha, commit]));
    const preset = input.presetGroups ?? [];
    const presetShas = new Set(preset.flatMap((group) => group.commits));
    const commits = input.commits.filter((commit) => !presetShas.has(commit.sha));
    const reverts = planReverts(commits, input.prior, input.attachable, rules);
    const groups: DraftGroup[] = [...preset, ...reverts.decided];
    const inLlmChain = new Set(reverts.llmChains.flatMap((chain) => chain.shas));
    const units: string[][] = [];
    const chainHints = new Map<string, string>();
    for (const chain of reverts.llmChains) {
      units.push([...chain.shas]);
      for (const sha of chain.shas) chainHints.set(sha, chain.hint);
    }
    for (const commit of commits) {
      if (reverts.handled.has(commit.sha) || inLlmChain.has(commit.sha)) continue;
      if (!reverts.hints.has(commit.sha)) {
        const key = matchAutoSkipRule(commit.paths, rules);
        if (key) {
          groups.push(ruleSkip([commit], rules, key));
          continue;
        }
      }
      units.push([commit.sha]);
    }
    // Keep LLM units chronological.
    const order = new Map(input.commits.map((commit, index) => [commit.sha, index]));
    units.sort((a, b) => order.get(a[0]!)! - order.get(b[0]!)!);

    if (!input.triage) {
      for (const unit of units) {
        if (unit.length > 1) {
          const first = bySha.get(unit[0]!)!;
          groups.push({
            ...plainGroup(first),
            commits: [...unit],
            revertChain: true,
            summary: chainHints.get(first.sha) ?? "",
          });
        } else groups.push(plainGroup(bySha.get(unit[0]!)!));
      }
      return { groups, llmCalls: 0, policyTruncated: false };
    }

    const call = input.triage;
    const calls = yield* Ref.make(0);
    const circuit = input.circuit ?? { consecutiveFailures: 0 };
    const policyTruncated = yield* Ref.make(false);
    const newGroups: DraftGroup[] = [];
    const semaphore = input.semaphore ?? globalTriageSemaphore;

    const digestFor = (sha: string): TriageCommitDigest => {
      const commit = bySha.get(sha)!;
      const hints = [
        ...commit.digest.hints,
        ...(reverts.hints.has(sha) ? [reverts.hints.get(sha)!] : []),
        ...(chainHints.has(sha)
          ? [`${chainHints.get(sha)!}; keep this revert chain in one group`]
          : []),
      ];
      return { ...commit.digest, hints };
    };

    type BatchOutcome =
      | { readonly ok: true; readonly value: ValidatedBatch }
      | {
          readonly ok: false;
          readonly kind: "batch" | "provider" | "budget";
          readonly detail: string;
        };

    const budget = input.budget;
    /** Reserves one call, or reports why the run has no budget left. */
    const reserveCall = Effect.gen(function* () {
      if (budget && budget.now() >= budget.deadlineAt) return "the run deadline was reached";
      const reserved = yield* Ref.modify(calls, (n) =>
        budget && n >= budget.calls ? [false, n] : [true, n + 1],
      );
      return reserved ? null : "the run's call budget was reached";
    });

    const runBatch = (shas: ReadonlyArray<string>, newRows: ReadonlyArray<TriageTopicRow>) =>
      Effect.gen(function* () {
        const { prompt, policyTruncated: truncated } = buildTriageBatchPrompt({
          repository: input.repository,
          policy: input.policy,
          rules,
          openTopics: input.openTopics,
          newGroups: newRows,
          commits: shas.map(digestFor),
        });
        if (truncated) yield* Ref.set(policyTruncated, true);
        const exhausted = yield* reserveCall;
        if (exhausted !== null)
          return { ok: false, kind: "budget", detail: exhausted } satisfies BatchOutcome;
        return yield* semaphore
          .withPermits(1)(call(prompt))
          .pipe(
            Effect.map(
              (output): BatchOutcome => ({
                ok: true,
                value: validateBatchOutput(shas, output, rules, model),
              }),
            ),
            Effect.catch((error) =>
              Effect.succeed<BatchOutcome>({
                ok: false,
                kind: isBatchFailure(error)
                  ? "batch"
                  : PROVIDER_KINDS.has(error.kind)
                    ? "provider"
                    : "batch",
                detail: error.message,
              }),
            ),
          );
      });

    const noteProvider = (outcome: BatchOutcome) =>
      Effect.gen(function* () {
        if (outcome.ok || outcome.kind !== "provider") {
          if (outcome.ok) circuit.consecutiveFailures = 0;
          return;
        }
        circuit.consecutiveFailures += 1;
        if (circuit.consecutiveFailures >= PROVIDER_FAILURE_LIMIT)
          return yield* Effect.fail(
            new ProviderUnavailableError(outcome.detail, yield* Ref.get(calls)),
          );
      });

    /** One batch with the split-once retry for timeouts and invalid output. */
    const triageBatch = (shas: ReadonlyArray<string>, newRows: ReadonlyArray<TriageTopicRow>) =>
      Effect.gen(function* () {
        const first = yield* runBatch(shas, newRows);
        yield* noteProvider(first);
        if (first.ok)
          return { validated: [first.value], failed: [] as Array<{ sha: string; detail: string }> };
        if (first.kind === "provider" || first.kind === "budget")
          return { validated: [], failed: shas.map((sha) => ({ sha, detail: first.detail })) };
        const halves =
          shas.length > 1
            ? [shas.slice(0, Math.ceil(shas.length / 2)), shas.slice(Math.ceil(shas.length / 2))]
            : [shas];
        const validated: ValidatedBatch[] = [];
        const failed: Array<{ sha: string; detail: string }> = [];
        for (const half of halves) {
          const retry = yield* runBatch(half, newRows);
          yield* noteProvider(retry);
          if (retry.ok) validated.push(retry.value);
          else failed.push(...half.map((sha) => ({ sha, detail: retry.detail })));
        }
        return { validated, failed };
      });

    const batches = batchCommits(units, input.batchSize ?? DEFAULT_BATCH_SIZE);
    const concurrency = input.concurrency ?? WAVE_CONCURRENCY;
    for (let start = 0; start < batches.length; start += concurrency) {
      const wave = batches.slice(start, start + concurrency);
      const newRows: TriageTopicRow[] = newGroups
        .filter((group) => group.attachTo === null)
        .slice(-200)
        .map((group) => ({
          id: group.key,
          state: group.decision ? "skipped" : "new",
          title: group.title,
          summary: group.summary,
        }));
      const results = yield* Effect.forEach(wave, (shas) => triageBatch(shas, newRows), {
        concurrency,
      });
      for (const result of results) {
        for (const { sha, detail } of result.failed)
          newGroups.push(
            inboxFallback(bySha.get(sha)!, model, `triage failed: ${truncate(detail, 160)}`),
          );
        for (const batch of result.validated) {
          for (const sha of batch.omitted)
            newGroups.push(inboxFallback(bySha.get(sha)!, model, "omitted by triage"));
          for (const group of batch.groups) {
            const chain = group.commits.some((sha) => chainHints.has(sha));
            const suggestion = chain
              ? {
                  ...group.suggestion,
                  reason: truncate(
                    `${chainHints.get(group.commits.find((sha) => chainHints.has(sha))!)}. ${group.suggestion.reason}`,
                    UPSTREAM_SUGGESTION_REASON_MAX,
                  ),
                }
              : group.suggestion;
            const target = group.attachTo;
            const existingNew = target
              ? newGroups.find(
                  (candidate) =>
                    candidate.key === target && candidate.attachTo === null && !candidate.decision,
                )
              : undefined;
            if (existingNew) {
              existingNew.commits = input.commits
                .map((commit) => commit.sha)
                .filter((sha) => existingNew.commits.includes(sha) || group.commits.includes(sha));
              if (existingNew.suggestion)
                existingNew.suggestion = mergeSuggestions(existingNew.suggestion, suggestion);
              existingNew.revertChain = existingNew.revertChain || chain;
              continue;
            }
            const attachTo = target && input.attachable.has(target) ? target : null;
            const related = [
              ...(target && !attachTo && !newGroups.some((candidate) => candidate.key === target)
                ? [target]
                : []),
              ...(group.relatedTo ? [group.relatedTo] : []),
            ];
            newGroups.push({
              key: newGroups.some((candidate) => candidate.key === group.key)
                ? `${group.key}-${group.commits[0]!.slice(0, 7)}`
                : group.key,
              commits: [...group.commits],
              attachTo,
              related: [...new Set(related)],
              title: group.title,
              summary: group.summary,
              suggestion,
              decision: null,
              revertChain: chain,
            });
          }
        }
      }
    }
    for (const group of newGroups) if (!group.attachTo) group.decision = autoDecision(group, rules);
    return {
      groups: [...groups, ...newGroups],
      llmCalls: yield* Ref.get(calls),
      policyTruncated: yield* Ref.get(policyTruncated),
    };
  });
}

export interface BuiltChunk {
  readonly topics: ReadonlyArray<UpstreamTopic>;
  /** Membership for every chunk commit. */
  readonly membership: ReadonlyMap<string, string>;
  readonly inboxCount: number;
  readonly autoDecidedCount: number;
}

/**
 * Turns draft groups into topics with minted ids. Attach targets are checked
 * again against the current view: a target decided in the meantime becomes
 * `relatedTopics` on a new topic. Related keys of new groups map to their ids.
 */
export function buildTopics(input: {
  readonly groups: ReadonlyArray<DraftGroup>;
  readonly commits: ReadonlyArray<ChunkCommit>;
  readonly attachable: ReadonlySet<string>;
  readonly existingIds: ReadonlySet<string>;
  readonly now: string;
}): BuiltChunk {
  const bySha = new Map(input.commits.map((commit) => [commit.sha, commit]));
  const taken = new Set(input.existingIds);
  const membership = new Map<string, string>();
  const keyToId = new Map<string, string>();
  const drafts: Array<{
    readonly group: DraftGroup;
    readonly id: string;
    readonly related: string[];
  }> = [];
  for (const group of input.groups) {
    if (group.commits.length === 0) continue;
    if (group.attachTo && input.attachable.has(group.attachTo)) {
      for (const sha of group.commits) membership.set(sha, group.attachTo);
      continue;
    }
    const related = group.attachTo ? [group.attachTo, ...group.related] : [...group.related];
    const primary =
      group.commits.map((sha) => bySha.get(sha)!).find((commit) => commit.pr !== null) ??
      bySha.get(group.commits[0]!)!;
    const id = topicIdFor({ sha: primary.sha, pr: primary.pr }, taken);
    taken.add(id);
    keyToId.set(group.key, id);
    drafts.push({ group, id, related });
    for (const sha of group.commits) membership.set(sha, id);
  }
  let inboxCount = 0;
  let autoDecidedCount = 0;
  const topics = drafts.map(({ group, id, related }): UpstreamTopic => {
    const prs = [
      ...new Set(
        group.commits.map((sha) => bySha.get(sha)!.pr).filter((pr): pr is number => pr !== null),
      ),
    ];
    const relatedIds = [
      ...new Set(
        related
          .map((value) => keyToId.get(value) ?? value)
          .filter((value) => value !== id && (taken.has(value) || input.existingIds.has(value))),
      ),
    ].toSorted();
    const decision = group.decision;
    if (decision) autoDecidedCount += 1;
    else inboxCount += 1;
    return {
      id,
      createdAt: input.now,
      title: truncate(group.title || id, UPSTREAM_TOPIC_TITLE_MAX),
      summary: truncate(group.summary, UPSTREAM_TOPIC_SUMMARY_MAX),
      upstreamPrs: prs,
      status: decision ? "skip" : "inbox",
      epoch: 1,
      ...(decision
        ? {
            reasonKey: decision.reasonKey,
            reason: truncate(decision.reason, UPSTREAM_SUGGESTION_REASON_MAX),
            decidedBy: decision.decidedBy,
            decidedAt: input.now,
          }
        : {}),
      ...(group.suggestion ? { suggestion: group.suggestion } : {}),
      ...(relatedIds.length ? { relatedTopics: relatedIds } : {}),
    };
  });
  return { topics, membership, inboxCount, autoDecidedCount };
}

/** Legacy equivalence: deferred archive records whose f5 SHAs are all on the base, grouped by SHA set. */
export function legacyEquivalenceGroups(input: {
  readonly commits: ReadonlyArray<ChunkCommit>;
  readonly f5ShasBySha: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly reachable: ReadonlySet<string>;
}): DraftGroup[] {
  const bySet = new Map<string, { shas: string[]; refs: string[] }>();
  for (const commit of input.commits) {
    const refs = input.f5ShasBySha.get(commit.sha) ?? [];
    if (refs.length === 0 || !refs.every((sha) => input.reachable.has(sha))) continue;
    const key = [...refs].toSorted().join(",");
    const entry = bySet.get(key) ?? { shas: [], refs: [...refs].toSorted() };
    entry.shas.push(commit.sha);
    bySet.set(key, entry);
  }
  const bySha = new Map(input.commits.map((commit) => [commit.sha, commit]));
  return [...bySet.values()].map((entry) => {
    const first = bySha.get(entry.shas[0]!)!;
    return {
      key: `legacy-equivalent:${entry.refs[0]}`,
      commits: entry.shas,
      attachTo: null,
      related: [],
      title: truncate(oneLine(first.subject) || first.sha.slice(0, 12), UPSTREAM_TOPIC_TITLE_MAX),
      summary:
        entry.shas.length > 1
          ? `${entry.shas.length} archived commits implemented by the same f5 commits.`
          : "",
      suggestion: {
        status: "equivalent",
        reason: "Implementation commits recorded in the earlier catch-up are on main",
        userImpact: "none",
        confidence: LEGACY_EQUIVALENT_CONFIDENCE,
        areas: [],
        model: "rule",
        f5Refs: entry.refs,
      },
      decision: null,
      revertChain: false,
    };
  });
}
