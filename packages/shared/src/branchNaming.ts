/**
 * One naming policy for every branch F5 creates:
 *
 * - placeholder (instant, no model call): `<prefix>/wip/<slug-from-message>`
 * - final (after the model names the work): `<prefix>/<type>/<slug>`
 * - pull request checkout: `<prefix>/pr-<number>/<head>`
 *
 * `wip` is reserved for placeholders, so a placeholder is recognizable by its
 * shape alone. Older builds used `t3code/<8 hex>` placeholders; those stay
 * recognized so existing threads keep renaming and resolving correctly.
 */

export const DEFAULT_BRANCH_PREFIX = "f5";
export const PLACEHOLDER_BRANCH_SEGMENT = "wip";
export const BRANCH_TYPES = ["feat", "fix", "refactor", "chore", "docs", "perf", "test"] as const;
export type BranchType = (typeof BRANCH_TYPES)[number];

export const PLACEHOLDER_BRANCH_RESERVED_MESSAGE = "wip/ is reserved for F5 placeholder branches.";

/** The prefix older builds used for placeholder and pull request branches. */
export const LEGACY_BRANCH_PREFIX = "t3code";

const SLUG_MAX_LENGTH = 48;
const SLUG_MAX_WORDS = 5;
const PLACEHOLDER_FALLBACK_SLUG = "new-thread";
const FINAL_FALLBACK_SLUG = "update";

const STOPWORDS = new Set([
  "please",
  "can",
  "you",
  "the",
  "a",
  "an",
  "to",
  "i",
  "we",
  "lets",
  "should",
  "would",
  "could",
  "this",
  "that",
  "and",
  "for",
  "of",
  "in",
  "on",
  "with",
]);

const LEGACY_PLACEHOLDER_PATTERN =
  /^t3code(?:-[0-9a-f]{8}|\/(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}))$/;
const PLACEHOLDER_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const BRANCH_TYPE_SET: ReadonlySet<string> = new Set(BRANCH_TYPES);

/** Type inference rules, checked in order against every slug word. */
const TYPE_RULES: ReadonlyArray<{ readonly type: BranchType; readonly test: RegExp }> = [
  { type: "fix", test: /^(?:fix(?:e[sd]|ing)?|bugs?|bugfix|crash(?:es|ing)?|broken|errors?)$/ },
  { type: "refactor", test: /^(?:refactor\w*|cleanup|rename[sd]?|renaming|extract\w*)$/ },
  { type: "docs", test: /^(?:docs?|documentation|readme)$/ },
  { type: "perf", test: /^(?:perf|performance|slow\w*|speed(?:up)?|latency)$/ },
  { type: "test", test: /^(?:tests?|testing|specs?|flaky|flakes?|flakiness)$/ },
  { type: "chore", test: /^(?:release|bump|deps|dependencies|ci)$/ },
];

export function isBranchType(value: unknown): value is BranchType {
  return typeof value === "string" && BRANCH_TYPE_SET.has(value);
}

/** The configured prefix as a ref-safe path. Empty means `f5`. */
export function normalizeBranchPrefix(raw: string | null | undefined): string {
  const prefix = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .split("/")
    .map((segment) => segment.replace(/^[-_]+|[-_]+$/g, ""))
    // `wip` marks placeholders, so it cannot be part of the prefix.
    .filter((segment) => segment.length > 0 && segment !== PLACEHOLDER_BRANCH_SEGMENT)
    .join("/");
  return prefix || DEFAULT_BRANCH_PREFIX;
}

function capSlug(words: ReadonlyArray<string>): string {
  const kept = [...words];
  while (kept.length > 1 && kept.join("-").length > SLUG_MAX_LENGTH) kept.pop();
  return kept.join("-").slice(0, SLUG_MAX_LENGTH).replace(/-+$/, "");
}

function slugWords(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * A short kebab-case slug describing free text, such as a first message.
 * Drops code, links, mentions, paths and filler words; never empty.
 */
export function slugifyBranchText(text: string): string {
  const cleaned = text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
    .replace(/(^|\s)@\S+/g, " ")
    .split(/\s+/)
    .filter((token) => !/[/\\]/.test(token))
    .join(" ");
  const words = slugWords(cleaned)
    .filter((word) => !STOPWORDS.has(word))
    .slice(0, SLUG_MAX_WORDS);
  return words.length > 0 ? capSlug(words) : PLACEHOLDER_FALLBACK_SLUG;
}

/** `<prefix>/wip/<slug>`: the name a worktree branch holds until the model names it. */
export function buildPlaceholderBranchName(input: {
  readonly prefix?: string | null | undefined;
  readonly sourceText?: string | null | undefined;
}): string {
  return `${normalizeBranchPrefix(input.prefix)}/${PLACEHOLDER_BRANCH_SEGMENT}/${slugifyBranchText(
    input.sourceText ?? "",
  )}`;
}

export function inferBranchType(slug: string): BranchType {
  const words = slug.split(/[^a-z0-9]+/).filter(Boolean);
  for (const rule of TYPE_RULES) {
    if (words.some((word) => rule.test.test(word))) return rule.type;
  }
  return "feat";
}

/**
 * `<prefix>/<type>/<slug>` from a model-generated name. Strips any prefix, legacy
 * `t3code/`, or type segment the model echoed back so nothing doubles up.
 */
export function buildFinalBranchName(input: {
  readonly prefix?: string | null | undefined;
  readonly type?: string | null | undefined;
  readonly slug: string;
}): string {
  const prefix = normalizeBranchPrefix(input.prefix);
  let rest = input.slug
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "")
    .replace(/^\/+|\/+$/g, "");
  let echoedType: BranchType | undefined;
  for (let changed = true; changed; ) {
    changed = false;
    for (const lead of [`${LEGACY_BRANCH_PREFIX}/`, `${prefix}/`]) {
      if (rest.startsWith(lead)) {
        rest = rest.slice(lead.length);
        changed = true;
      }
    }
    const [first, ...others] = rest.split("/");
    if (others.length > 0 && first !== undefined) {
      const alias = first === "feature" ? "feat" : first === "bugfix" ? "fix" : first;
      if (isBranchType(alias) || alias === PLACEHOLDER_BRANCH_SEGMENT) {
        if (isBranchType(alias)) echoedType ??= alias;
        rest = others.join("/");
        changed = true;
      }
    }
  }
  const words = slugWords(rest.replace(/\//g, " "));
  const slug = words.length > 0 ? capSlug(words) : FINAL_FALLBACK_SLUG;
  const requested = input.type?.trim().toLowerCase();
  const type = isBranchType(requested) ? requested : (echoedType ?? inferBranchType(slug));
  return `${prefix}/${type}/${slug}`;
}

/**
 * True for F5 placeholder branches: `<prefix>/wip/<slug>` under the effective Branch
 * prefix (empty means `f5`), and the `t3code/<hex>` names older builds created.
 * Only the configured prefix counts, so `alice/wip/spike` or `f5/pr-1/wip/x` is
 * never mistaken for one. Matching ignores case, as refs do on macOS and Windows.
 */
export function isPlaceholderBranch(branch: string, prefix?: string | null): boolean {
  const name = branch.trim().toLowerCase();
  if (LEGACY_PLACEHOLDER_PATTERN.test(name)) return true;
  const lead = `${normalizeBranchPrefix(prefix)}/${PLACEHOLDER_BRANCH_SEGMENT}/`;
  return name.startsWith(lead) && PLACEHOLDER_SLUG_PATTERN.test(name.slice(lead.length));
}

/** 8 hex characters that stay the same for the same input (FNV-1a). */
export function stableShortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** True only for the `t3code/<hex>` placeholders older builds created. */
export function isLegacyPlaceholderBranch(branch: string): boolean {
  return LEGACY_PLACEHOLDER_PATTERN.test(branch.trim().toLowerCase());
}

/** A plain `t3code` ref occupies the directory required by `t3code/<token>`. */
export function flattenLegacyPlaceholderBranchName(branch: string): string {
  const token = branch
    .trim()
    .toLowerCase()
    .slice(LEGACY_BRANCH_PREFIX.length + 1, LEGACY_BRANCH_PREFIX.length + 9);
  return `${LEGACY_BRANCH_PREFIX}-${token}`;
}

/**
 * The placeholder for a new worktree opened because `branch` is checked out
 * elsewhere. Preparation is idempotent per branch name, so the name stays the same
 * for the same thread and differs between threads.
 */
export function buildCheckoutConflictBranchName(input: {
  readonly prefix?: string | null | undefined;
  readonly branch: string;
  readonly threadId: string;
}): string {
  return `${buildPlaceholderBranchName({
    prefix: input.prefix,
    sourceText: input.branch.replace(/[\\/]+/g, " "),
  })}-${stableShortHash(input.threadId)}`;
}

/** `<prefix>/pr-<number>/<head>`: the local branch for a cross-repository pull request. */
export function buildPullRequestBranchName(input: {
  readonly prefix?: string | null | undefined;
  readonly number: number;
  readonly headFragment: string;
}): string {
  return `${normalizeBranchPrefix(input.prefix)}/pr-${input.number}/${input.headFragment}`;
}

/** The name older builds gave the same pull request branch, reused when it still exists. */
export function buildLegacyPullRequestBranchName(input: {
  readonly number: number;
  readonly headFragment: string;
}): string {
  return `${LEGACY_BRANCH_PREFIX}/pr-${input.number}/${input.headFragment}`;
}
