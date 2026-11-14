import type { PrHubListInput, PrHubSection } from "@t3tools/contracts";

/** Everything the queue keeps in the URL, so Back, Forward and shared links restore it. */
export interface PrQueueSearch {
  /** The open pull request: shown in the peek, or full-page with `view: "page"`. */
  pr?: string;
  view?: "page";
  tab?: PrQueueTab;
  q?: string;
  repo?: string;
  author?: string;
  label?: string;
  ci?: PrQueueCi;
  review?: PrQueueReview;
  draft?: PrQueueDraft;
  status?: Exclude<PrQueueStatus, "active">;
}

export const PR_QUEUE_STATUSES = ["active", "snoozed", "ignored", "closed"] as const;
export type PrQueueStatus = (typeof PR_QUEUE_STATUSES)[number];
export const PR_QUEUE_TABS = ["overview", "conversation", "threads", "files", "guide"] as const;
export type PrQueueTab = (typeof PR_QUEUE_TABS)[number];
export const PR_QUEUE_CI = ["success", "failure", "error", "pending", "none"] as const;
export type PrQueueCi = (typeof PR_QUEUE_CI)[number];
export const PR_QUEUE_REVIEW = [
  "approved",
  "changes_requested",
  "review_required",
  "none",
] as const;
export type PrQueueReview = (typeof PR_QUEUE_REVIEW)[number];
export const PR_QUEUE_DRAFT = ["only", "hide"] as const;
export type PrQueueDraft = (typeof PR_QUEUE_DRAFT)[number];

/** Rows per section request; "Show more" loads the next page. */
export const PR_QUEUE_PAGE_SIZE = 25;

const text = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
};

const oneOf = <const T extends string>(value: unknown, options: readonly T[]): T | undefined =>
  options.find((option) => option === value);

/** Reads the queue state from raw URL search params, dropping anything it does not know. */
export function parsePrQueueSearch(input: Record<string, unknown>): PrQueueSearch {
  const pr = text(input.pr, 512);
  const page = pr !== undefined && input.view === "page";
  const tab = page ? oneOf(input.tab, PR_QUEUE_TABS) : undefined;
  const status = oneOf(input.status, PR_QUEUE_STATUSES);
  // The search field keeps the user's spacing, so only its length is checked.
  const q = typeof input.q === "string" && input.q.length <= 500 && input.q.trim() ? input.q : "";
  const search: { [Key in keyof PrQueueSearch]: PrQueueSearch[Key] | undefined } = {
    pr,
    view: page ? "page" : undefined,
    tab: tab === "overview" ? undefined : tab,
    q: q || undefined,
    repo: text(input.repo, 200),
    author: text(input.author, 100),
    label: text(input.label, 100),
    ci: oneOf(input.ci, PR_QUEUE_CI),
    review: oneOf(input.review, PR_QUEUE_REVIEW),
    draft: oneOf(input.draft, PR_QUEUE_DRAFT),
    status: status === "active" ? undefined : status,
  };
  // Absent keys stay out of the URL.
  return Object.fromEntries(
    Object.entries(search).filter(([, value]) => value !== undefined),
  ) as PrQueueSearch;
}

export const PR_QUEUE_FACETS = ["repo", "author", "label", "ci", "review", "draft"] as const;
export type PrQueueFacet = (typeof PR_QUEUE_FACETS)[number];

/** Whether a search or a filter narrows the queue. */
export function prQueueIsFiltered(search: PrQueueSearch): boolean {
  return Boolean(search.q?.trim()) || PR_QUEUE_FACETS.some((facet) => search[facet] !== undefined);
}

const qualifierValue = (value: string) =>
  /[\s,]/.test(value) ? `"${value.replaceAll('"', "")}"` : value;

/** The search text sent to the server: what was typed, plus the author and label filters. */
export function prQueueQuery(search: PrQueueSearch): string {
  return [
    search.q?.trim(),
    search.author ? `author:${qualifierValue(search.author)}` : undefined,
    search.label ? `label:${qualifierValue(search.label)}` : undefined,
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 500);
}

export interface PrQueueSuggestion {
  /** What the row shows, e.g. `repo:` or `repo:octo/web`. */
  readonly label: string;
  readonly detail?: string;
  /** The whole search text after accepting the suggestion. */
  readonly text: string;
}

export interface PrQueueFacetValues {
  readonly repositories: readonly string[];
  readonly authors: readonly string[];
  readonly labels: readonly string[];
}

const QUALIFIERS: ReadonlyArray<{ readonly key: string; readonly detail: string }> = [
  { key: "repo", detail: "Repository" },
  { key: "author", detail: "Author, or me" },
  { key: "label", detail: "Label" },
  { key: "review", detail: "Review decision" },
  { key: "status", detail: "Checks" },
  { key: "draft", detail: "Drafts only, or none" },
];

const FIXED_VALUES: Readonly<Record<string, readonly string[]>> = {
  review: ["approved", "changes-requested", "required", "none"],
  status: ["passing", "failing", "pending"],
  draft: ["true", "false"],
};

const MAX_SUGGESTIONS = 8;

/**
 * Completions for the word being typed at the end of the search text: qualifier names
 * first, then that qualifier's values. Nothing is offered inside an open quote.
 */
export function prQueueSuggestions(
  text: string,
  facets: PrQueueFacetValues | undefined,
): PrQueueSuggestion[] {
  if ((text.match(/"/g)?.length ?? 0) % 2 === 1) return [];
  const word = /(?:^|\s)(\S+)$/.exec(text)?.[1];
  if (!word) return [];
  const head = text.slice(0, text.length - word.length);
  const match = /^(-?)([a-z]+)(?::(.*))?$/i.exec(word);
  if (!match) return [];
  const [, negation = "", rawKey = "", partial] = match;
  const key = rawKey.toLowerCase();
  if (partial === undefined) {
    return QUALIFIERS.filter((qualifier) => qualifier.key.startsWith(key)).map((qualifier) => ({
      label: `${negation}${qualifier.key}:`,
      detail: qualifier.detail,
      text: `${head}${negation}${qualifier.key}:`,
    }));
  }
  const values =
    key === "repo"
      ? facets?.repositories
      : key === "author"
        ? [...new Set(["me", ...(facets?.authors ?? [])])]
        : key === "label"
          ? facets?.labels
          : Object.hasOwn(FIXED_VALUES, key)
            ? FIXED_VALUES[key]
            : undefined;
  const typed = partial.replaceAll('"', "").toLowerCase();
  return (values ?? [])
    .filter((value) => value.toLowerCase().includes(typed) && value.toLowerCase() !== typed)
    .slice(0, MAX_SUGGESTIONS)
    .map((value) => ({
      label: `${negation}${key}:${value}`,
      text: `${head}${negation}${key}:${qualifierValue(value)} `,
    }));
}

const VISIBILITY = {
  active: "active",
  snoozed: "snoozed",
  ignored: "ignored",
  closed: "resolved",
} as const satisfies Record<PrQueueStatus, NonNullable<PrHubListInput["visibility"]>>;

/**
 * The list request for the active queue, in section order and optionally limited to one
 * section, or for a status list (snoozed, ignored, closed), which has no sections and
 * reads newest first.
 */
export function prQueueListInput(search: PrQueueSearch, section?: PrHubSection): PrHubListInput {
  const status = search.status ?? "active";
  const query = prQueueQuery(search);
  return {
    limit: PR_QUEUE_PAGE_SIZE,
    visibility: VISIBILITY[status],
    ...(status !== "active" ? { sort: "updated" as const } : section ? { section } : {}),
    ...(query ? { query } : {}),
    ...(search.repo ? { repository: search.repo } : {}),
    ...(search.ci ? { ci: search.ci } : {}),
    ...(search.review ? { review: search.review } : {}),
    ...(search.draft ? { draft: search.draft } : {}),
  };
}
