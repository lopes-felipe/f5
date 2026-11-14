import type { SourceControlProviderKind } from "@t3tools/contracts";

/** A reviewer as the forge identifies it: `id` is what a request sends, `label` what is shown. */
export interface PrReviewerOption {
  readonly id: string;
  readonly label: string;
}

export interface PrReviewerSet {
  /** False when a current reviewer has no usable id; a change would drop that reviewer. */
  readonly known: boolean;
  readonly current: readonly PrReviewerOption[];
  readonly candidates: readonly PrReviewerOption[];
  readonly candidatesSupported: boolean;
}

const object = (value: unknown): Readonly<Record<string, unknown>> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
const rows = (value: unknown): readonly unknown[] =>
  Array.isArray(value)
    ? value
    : Array.isArray(object(value).values)
      ? (object(value).values as unknown[])
      : Array.isArray(object(value).value)
        ? (object(value).value as unknown[])
        : [];
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);

function normalizeReviewer(
  value: unknown,
  provider: SourceControlProviderKind,
): PrReviewerOption | null {
  const raw = object(value);
  const user = object(raw.user ?? value);
  if (raw.role && raw.role !== "REVIEWER") return null;
  const native =
    provider === "github" || provider === "forgejo"
      ? user.login
      : provider === "bitbucket"
        ? user.uuid
        : user.id;
  const id = typeof native === "number" && Number.isFinite(native) ? String(native) : text(native);
  if (!id) return null;
  return {
    id,
    label:
      text(
        user.username ??
          user.login ??
          user.nickname ??
          user.display_name ??
          user.displayName ??
          user.name,
      ) ?? id,
  };
}

/** Reads the forge's reviewer listing, whose shape differs per provider. */
export function prReviewerSet(value: unknown, provider: SourceControlProviderKind): PrReviewerSet {
  const response = object(value);
  const expected = rows(response.currentReviewers).filter(
    (reviewer) => !object(reviewer).role || object(reviewer).role === "REVIEWER",
  );
  const existing = expected.map((reviewer) => normalizeReviewer(reviewer, provider));
  return {
    known:
      Array.isArray(response.currentReviewers) && existing.every((reviewer) => reviewer !== null),
    current: existing.filter((reviewer): reviewer is PrReviewerOption => reviewer !== null),
    candidates: rows(response.candidates)
      .map((reviewer) => normalizeReviewer(reviewer, provider))
      .filter((reviewer): reviewer is PrReviewerOption => reviewer !== null),
    candidatesSupported: response.candidatesSupported !== false,
  };
}

/**
 * Whether a reviewer may be typed instead of picked. GitHub and Forgejo identify reviewers
 * by login, which people know; the others need the forge's own id, so typing is offered
 * only where the forge cannot list candidates.
 */
export function prReviewerAllowsCustom(
  provider: SourceControlProviderKind,
  candidatesSupported: boolean,
): boolean {
  return provider === "github" || provider === "forgejo" || !candidatesSupported;
}

/** The picker's choices: current reviewers first, then candidates, then anything typed. */
export function prReviewerOptions(
  set: PrReviewerSet | null,
  selected: readonly string[],
): PrReviewerOption[] {
  const options = new Map<string, PrReviewerOption>();
  for (const option of [...(set?.current ?? []), ...(set?.candidates ?? [])]) {
    if (!options.has(option.id)) options.set(option.id, option);
  }
  for (const id of selected) if (!options.has(id)) options.set(id, { id, label: id });
  return [...options.values()];
}

/** What to request and what to withdraw to get from `initial` to `selected`. */
export function prReviewerChange(
  initial: readonly string[],
  selected: readonly string[],
): { add: string[]; remove: string[] } {
  const lower = (values: readonly string[]) => new Set(values.map((value) => value.toLowerCase()));
  const before = lower(initial);
  const after = lower(selected);
  return {
    add: selected.filter((value) => !before.has(value.toLowerCase())),
    remove: initial.filter((value) => !after.has(value.toLowerCase())),
  };
}
