import type { ProviderApprovalDecision, ProviderApprovalOption } from "@t3tools/contracts";

/**
 * What a Codex command approval request offers the client (0.160.1
 * `CommandExecutionRequestApprovalParams`): an ordered `availableDecisions`
 * list and an optional `proposedExecpolicyAmendment` (a command prefix that
 * would be allowed without prompting from then on).
 *
 * The server stores this offer next to the pending request and validates every
 * response against it; the browser only ever picks one of the advertised
 * options. Network policy amendments are not representable and stay unsupported.
 */
export interface CodexCommandApprovalOffer {
  /** Undefined when the server did not send `availableDecisions` (older CLIs). */
  readonly decisions?: ReadonlySet<ProviderApprovalDecision>;
  /** Prefix for `acceptWithExecpolicyAmendment`; only set when it can be sent back. */
  readonly execpolicyAmendment?: ReadonlyArray<string>;
}

const MAX_AMENDMENT_TOKENS = 64;
const MAX_AMENDMENT_TOKEN_CHARS = 512;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readAmendment(value: unknown): ReadonlyArray<string> | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_AMENDMENT_TOKENS)
    return undefined;
  if (
    !value.every(
      (token) =>
        typeof token === "string" && token.length > 0 && token.length <= MAX_AMENDMENT_TOKEN_CHARS,
    )
  )
    return undefined;
  return value as ReadonlyArray<string>;
}

function sameAmendment(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

export function readCodexCommandApprovalOffer(params: unknown): CodexCommandApprovalOffer {
  const payload = record(params);
  const proposed = readAmendment(payload?.proposedExecpolicyAmendment);
  const available = payload?.availableDecisions;
  if (!Array.isArray(available)) {
    // Older servers do not list decisions; a proposed amendment alone is still
    // an offer the server documented as acceptable.
    return proposed ? { execpolicyAmendment: proposed } : {};
  }
  const decisions = new Set<ProviderApprovalDecision>();
  let execpolicyAmendment: ReadonlyArray<string> | undefined;
  for (const entry of available) {
    if (
      entry === "accept" ||
      entry === "acceptForSession" ||
      entry === "decline" ||
      entry === "cancel"
    ) {
      decisions.add(entry);
      continue;
    }
    const amendmentDecision = record(record(entry)?.acceptWithExecpolicyAmendment);
    if (!amendmentDecision) continue;
    const amendment = readAmendment(amendmentDecision.execpolicy_amendment) ?? proposed;
    // Two different prefixes in one offer cannot be told apart by one button.
    if (!amendment || (execpolicyAmendment && !sameAmendment(execpolicyAmendment, amendment)))
      continue;
    execpolicyAmendment = amendment;
    decisions.add("acceptAlways");
  }
  return { decisions, ...(execpolicyAmendment ? { execpolicyAmendment } : {}) };
}

export function formatExecpolicyAmendment(amendment: ReadonlyArray<string>): string {
  return amendment
    .map((token) => (/^[\w@%+=:,./-]+$/.test(token) ? token : JSON.stringify(token)))
    .join(" ");
}

const OPTION_ORDER: ReadonlyArray<ProviderApprovalDecision> = [
  "cancel",
  "decline",
  "acceptForSession",
  "acceptAlways",
  "accept",
];

/**
 * Approval buttons for an offer, or undefined when the default command
 * buttons already describe it exactly (no list, no amendment).
 */
export function codexCommandApprovalOptions(
  offer: CodexCommandApprovalOffer,
): ReadonlyArray<ProviderApprovalOption> | undefined {
  if (!offer.decisions && !offer.execpolicyAmendment) return undefined;
  const offered =
    offer.decisions ??
    new Set<ProviderApprovalDecision>(["cancel", "decline", "acceptForSession", "accept"]);
  const options: ProviderApprovalOption[] = [];
  for (const decision of OPTION_ORDER) {
    if (decision === "acceptAlways") {
      if (!offer.execpolicyAmendment || (offer.decisions && !offered.has("acceptAlways"))) continue;
      options.push({
        decision,
        label: `Always allow \`${formatExecpolicyAmendment(offer.execpolicyAmendment)}\``,
        warning: "Saved to Codex's command policy; matching commands run without asking.",
      });
      continue;
    }
    if (!offered.has(decision)) continue;
    options.push({
      decision,
      label:
        decision === "cancel"
          ? "Cancel turn"
          : decision === "decline"
            ? "Decline"
            : decision === "acceptForSession"
              ? "Always allow this session"
              : "Approve once",
    });
  }
  return options;
}

/** Validates a browser decision against the stored offer and builds the native decision. */
export function codexCommandApprovalDecision(
  offer: CodexCommandApprovalOffer,
  decision: ProviderApprovalDecision,
): unknown {
  if (decision === "acceptAlways") {
    if (!offer.execpolicyAmendment || (offer.decisions && !offer.decisions.has("acceptAlways")))
      throw new Error("This command approval did not offer a persistent command rule.");
    return {
      acceptWithExecpolicyAmendment: { execpolicy_amendment: [...offer.execpolicyAmendment] },
    };
  }
  if (offer.decisions && !offer.decisions.has(decision))
    throw new Error(`This command approval does not offer '${decision}'.`);
  return decision;
}
