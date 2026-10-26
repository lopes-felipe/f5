/**
 * Pure decision logic: turns a user decision into the exact canonical topic
 * fields a decision op stores.
 *
 * @module upstreamPorts/decisions
 */
import type { UpstreamDecision, UpstreamTopic, UpstreamTopicState } from "@t3tools/contracts";
import {
  addDays,
  hasValidEvidenceShape,
  isValidF5Ref,
  isValidReasonKey,
  reasonLabel,
  type DecisionFields,
  type Rules,
} from "@t3tools/shared/upstreamPorts";

export const WATCH_DAYS = 30;

export class DecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionError";
  }
}

export interface DecisionContext {
  readonly rules: Rules;
  readonly state: UpstreamTopicState;
  /** ISO time stamped as decidedAt. */
  readonly now: string;
  /** Local `YYYY-MM-DD`. */
  readonly today: string;
  /** Current `origin/<base>` SHA, the default f5 ref for `equivalent`. */
  readonly baseSha: string | null;
}

/**
 * The epoch increments whenever a topic moves to inbox or watch from a stored
 * `port` status or a derived `done` state, so old trailers and in-flight ports
 * stop counting and membership unfreezes.
 */
export function nextEpoch(
  topic: Pick<UpstreamTopic, "status" | "epoch">,
  state: UpstreamTopicState,
  target: UpstreamDecision["kind"],
): number {
  const reopening = target === "inbox" || target === "watch";
  return reopening && (topic.status === "port" || state === "done") ? topic.epoch + 1 : topic.epoch;
}

const trimmed = (value: string | undefined) => {
  const text = value?.trim();
  return text ? text : undefined;
};

export function decisionFields(
  topic: UpstreamTopic,
  decision: UpstreamDecision,
  context: DecisionContext,
): DecisionFields {
  const base = {
    epoch: nextEpoch(topic, context.state, decision.kind),
    decidedBy: "user" as const,
    decidedAt: context.now,
  };
  switch (decision.kind) {
    case "port":
      return {
        ...base,
        status: "port",
        ...(trimmed(decision.scope) ? { scope: trimmed(decision.scope)! } : {}),
      };
    case "skip": {
      if (!isValidReasonKey(context.rules, decision.reasonKey))
        throw new DecisionError(`Unknown skip reason ${decision.reasonKey}.`);
      return {
        ...base,
        status: "skip",
        reasonKey: decision.reasonKey,
        reason: trimmed(decision.reason) ?? reasonLabel(context.rules, decision.reasonKey),
      };
    }
    case "declined": {
      const reason = trimmed(decision.reason);
      if (!reason) throw new DecisionError("Declining needs a reason.");
      return { ...base, status: "declined", reason };
    }
    case "watch": {
      const revisitAfter = decision.revisitAfter ?? addDays(context.today, WATCH_DAYS);
      if (revisitAfter <= context.today)
        throw new DecisionError("The revisit date must be in the future.");
      return {
        ...base,
        status: "watch",
        revisitAfter,
        reason: trimmed(decision.reason) ?? `Revisit after ${revisitAfter}`,
      };
    }
    case "equivalent": {
      const f5Refs = (decision.f5Refs ?? []).map((ref) => ref.trim()).filter(Boolean);
      const refs = f5Refs.length ? f5Refs : context.baseSha ? [context.baseSha] : [];
      if (refs.length === 0)
        throw new DecisionError("Equivalent needs at least one f5 commit or PR.");
      const badRef = refs.find((ref) => !isValidF5Ref(ref));
      if (badRef) throw new DecisionError(`${badRef} is not a full f5 commit SHA or #<PR number>.`);
      const evidence = (decision.evidence ?? []).map((entry) => entry.trim()).filter(Boolean);
      const badEvidence = evidence.find((entry) => !hasValidEvidenceShape(entry));
      if (badEvidence) throw new DecisionError(`${badEvidence} is not a relative path:line.`);
      return {
        ...base,
        status: "equivalent",
        reason: trimmed(decision.reason) ?? "Already present in f5",
        equivalence: {
          f5Refs: refs,
          evidence,
        },
      };
    }
    case "inbox":
      return {
        ...base,
        status: "inbox",
        ...(trimmed(decision.reason) ? { reason: trimmed(decision.reason)! } : {}),
      };
  }
}

/** The decision a topic's stored suggestion implies, or null without one. */
export function suggestionDecision(topic: UpstreamTopic): UpstreamDecision | null {
  const suggestion = topic.suggestion;
  if (!suggestion || suggestion.triageError) return null;
  switch (suggestion.status) {
    case "port":
      return { kind: "port" };
    case "skip":
      return suggestion.reasonKey
        ? { kind: "skip", reasonKey: suggestion.reasonKey, reason: suggestion.reason }
        : null;
    case "watch":
      return { kind: "watch", reason: suggestion.reason };
    case "equivalent":
      return {
        kind: "equivalent",
        reason: suggestion.reason,
        ...(suggestion.f5Refs ? { f5Refs: suggestion.f5Refs } : {}),
      };
  }
}
