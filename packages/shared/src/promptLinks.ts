/**
 * Prompt links open F5 with a prompt ready to send: `f5://new?prompt=…` starts a new thread and
 * `f5://thread/<id>?prompt=…` fills an existing thread's composer. A link never sends anything.
 */
export const PROMPT_LINK_MAX_PROMPT_LENGTH = 8_000;

/** Production links use `f5://`; development builds register `f5-dev://` so both can coexist. */
export const PROMPT_LINK_SCHEME = "f5";
export const PROMPT_LINK_DEV_SCHEME = "f5-dev";

export interface PromptLinkRepository {
  readonly owner: string;
  readonly name: string;
}

export interface PromptLinkPullRequest extends PromptLinkRepository {
  readonly number: number;
}

export interface LinkedPrompt {
  readonly text: string;
  readonly hiddenCharacters: number;
}

export type NewThreadLink =
  | {
      readonly kind: "new";
      readonly prompt: LinkedPrompt;
      readonly repository: PromptLinkRepository | null;
      readonly provider: string | null;
      readonly model: string | null;
    }
  | {
      readonly kind: "pull-request";
      readonly pullRequest: PromptLinkPullRequest;
      readonly prompt: LinkedPrompt | null;
    };

export type PromptLinkResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

// Zero-width and bidi controls, tag and variation-selector blocks, and other characters that
// render as nothing. A model reads them; the person checking the draft cannot see them, which
// makes them the usual way to hide instructions in a prompt. Listed as code points so the
// source stays readable.
const HIDDEN_RANGES: ReadonlyArray<readonly [number, number?]> = [
  [0x0000, 0x0008],
  [0x000b],
  [0x000c],
  [0x000e, 0x001f],
  [0x007f, 0x009f],
  [0x00ad],
  [0x034f],
  [0x061c],
  [0x115f],
  [0x1160],
  [0x17b4],
  [0x17b5],
  [0x180b, 0x180f],
  [0x200b],
  [0x200c],
  [0x200e],
  [0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164],
  [0xfe00, 0xfe0d],
  [0xfeff],
  [0xffa0],
  [0xfff0, 0xfffb],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
];
const codePointPattern = (codePoint: number) => `\\u{${codePoint.toString(16)}}`;
const HIDDEN_CHARACTERS = new RegExp(
  `[${HIDDEN_RANGES.map(([from, to]) =>
    to === undefined ? codePointPattern(from) : `${codePointPattern(from)}-${codePointPattern(to)}`,
  ).join("")}]`,
  "gu",
);
const LINE_BREAKS = new RegExp(
  `\\r\\n?|[${codePointPattern(0x2028)}${codePointPattern(0x2029)}]`,
  "gu",
);
const ZERO_WIDTH_JOINER = String.fromCodePoint(0x200d);
// Emoji and the pieces emoji sequences are built from: pictographs, symbols, skin tones, and the
// emoji presentation selector.
const isEmojiPart = (codePoint: number | undefined) =>
  codePoint !== undefined &&
  ((codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
    (codePoint >= 0x2190 && codePoint <= 0x2bff) ||
    codePoint === 0xfe0f);

export function sanitizeLinkedPrompt(raw: string): LinkedPrompt {
  let hiddenCharacters = 0;
  const visible = Array.from(
    raw.replace(LINE_BREAKS, "\n").replace(HIDDEN_CHARACTERS, () => {
      hiddenCharacters++;
      return "";
    }),
  );
  const text = visible
    .filter((character, index) => {
      if (character !== ZERO_WIDTH_JOINER) return true;
      const kept =
        isEmojiPart(visible[index - 1]?.codePointAt(0)) &&
        isEmojiPart(visible[index + 1]?.codePointAt(0));
      if (!kept) hiddenCharacters++;
      return kept;
    })
    .join("");
  return { text: text.trim(), hiddenCharacters };
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

function repositoryOf(owner: string, name: string): PromptLinkRepository | null {
  const trimmedName = name.replace(/\.git$/i, "");
  if (!OWNER.test(owner) || !NAME.test(trimmedName) || /^\.+$/.test(trimmedName)) return null;
  return { owner, name: trimmedName };
}

export function parsePromptLinkRepository(value: string): PromptLinkRepository | null {
  const trimmed = value.trim();
  const url = /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)\/?$/i.exec(trimmed);
  const short = /^([^/\s]+)\/([^/\s]+)$/.exec(trimmed);
  const match = url ?? short;
  return match?.[1] && match[2] ? repositoryOf(match[1], match[2]) : null;
}

/** The GitHub repository a remote URL points at (https, ssh or scp-like), or null. */
export function promptLinkRepositoryOfRemote(remoteUrl: string): PromptLinkRepository | null {
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|git@)(?:www\.)?github\.com[:/]([^/\s]+)\/([^/\s]+?)\/?$/i.exec(
      remoteUrl.trim(),
    );
  return match?.[1] && match[2] ? repositoryOf(match[1], match[2]) : null;
}

export function samePromptLinkRepository(
  left: PromptLinkRepository,
  right: PromptLinkRepository,
): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase()
  );
}

function parsePromptLinkPullRequest(value: string): PromptLinkPullRequest | null {
  const trimmed = value.trim();
  const match =
    /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(
      trimmed,
    ) ?? /^([^/\s#]+)\/([^/\s#]+)(?:\/|#)(\d+)$/.exec(trimmed);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const repository = repositoryOf(match[1], match[2]);
  const number = Number(match[3]);
  return repository && Number.isSafeInteger(number) && number > 0
    ? { ...repository, number }
    : null;
}

export function promptLinkRepositoryUrl(repository: PromptLinkRepository): string {
  return `https://github.com/${repository.owner}/${repository.name}`;
}

export function promptLinkPullRequestUrl(pullRequest: PromptLinkPullRequest): string {
  return `${promptLinkRepositoryUrl(pullRequest)}/pull/${pullRequest.number}`;
}

function readPrompt(params: URLSearchParams): PromptLinkResult<LinkedPrompt | null> {
  const raw = params.get("prompt");
  if (raw === null) return { ok: true, value: null };
  if (raw.length > PROMPT_LINK_MAX_PROMPT_LENGTH) {
    return {
      ok: false,
      error: `This prompt is longer than ${PROMPT_LINK_MAX_PROMPT_LENGTH.toLocaleString("en-US")} characters, so F5 did not open it.`,
    };
  }
  const prompt = sanitizeLinkedPrompt(raw);
  if (prompt.text.length === 0 && prompt.hiddenCharacters > 0) {
    return {
      ok: false,
      error: "This prompt had only hidden characters, so it may be malicious. F5 did not open it.",
    };
  }
  return { ok: true, value: prompt.text.length > 0 ? prompt : null };
}

const optionalParam = (params: URLSearchParams, key: string) => params.get(key)?.trim() || null;

export function parseNewThreadLink(search: string): PromptLinkResult<NewThreadLink> {
  const params = new URLSearchParams(search);
  const prompt = readPrompt(params);
  if (!prompt.ok) return prompt;
  const pr = params.get("pr");
  if (pr !== null) {
    const pullRequest = parsePromptLinkPullRequest(pr);
    if (pullRequest === null) {
      return { ok: false, error: "This link names a pull request F5 cannot read." };
    }
    return { ok: true, value: { kind: "pull-request", pullRequest, prompt: prompt.value } };
  }
  if (prompt.value === null) return { ok: false, error: "This link has no prompt." };
  const repo = params.get("repo");
  const repository = repo === null ? null : parsePromptLinkRepository(repo);
  if (repo !== null && repository === null) {
    return { ok: false, error: "This link names a repository F5 cannot read." };
  }
  return {
    ok: true,
    value: {
      kind: "new",
      prompt: prompt.value,
      repository,
      provider: optionalParam(params, "provider"),
      model: optionalParam(params, "model"),
    },
  };
}

export function parseThreadLinkPrompt(search: string): PromptLinkResult<LinkedPrompt | null> {
  return readPrompt(new URLSearchParams(search));
}

export function withoutPromptLinkParams(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of ["prompt", "repo", "pr", "provider", "model"]) params.delete(key);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

export function buildNewThreadLink(input: {
  readonly prompt: string;
  readonly repository?: PromptLinkRepository | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly scheme?: string;
}): string {
  const url = new URL(`${input.scheme ?? PROMPT_LINK_SCHEME}://new`);
  url.searchParams.set("prompt", input.prompt);
  if (input.repository) {
    url.searchParams.set("repo", `${input.repository.owner}/${input.repository.name}`);
  }
  if (input.provider) url.searchParams.set("provider", input.provider);
  if (input.provider && input.model) url.searchParams.set("model", input.model);
  return url.toString();
}

export function buildThreadPromptLink(input: {
  readonly threadId: string;
  readonly prompt: string;
  readonly scheme?: string;
}): string {
  const url = new URL(
    `${input.scheme ?? PROMPT_LINK_SCHEME}://thread/${encodeURIComponent(input.threadId)}`,
  );
  url.searchParams.set("prompt", input.prompt);
  return url.toString();
}

const APP_SCHEME = /^f5(?:-[a-z]+)?:$/;
const THREAD_ID = /^\/([A-Za-z0-9_-]{1,128})\/?$/;
// A thread link opens `/<id>`, so an id naming one of the app's own screens would open that
// screen instead. Dot segments are refused before URL parsing resolves them for the same reason.
const RESERVED_ROUTES = new Set([
  "bots",
  "code-review",
  "debug",
  "investigation",
  "new",
  "pull-requests",
  "settings",
  "usage",
  "workflow",
  "worktrees",
]);
const DOT_SEGMENT = /\/\.\.?(?:[/?#]|$)/;
// Only the parameters each route reads pass through, so a link cannot also open a panel such as
// the file viewer (`?fileViewPath=.env`) next to the prompt.
const NEW_LINK_PARAMS = ["prompt", "repo", "pr", "provider", "model"] as const;
const THREAD_LINK_PARAMS = ["prompt"] as const;

function allowedSearch(url: URL, keys: ReadonlyArray<string>): string {
  const params = new URLSearchParams();
  for (const key of keys)
    for (const value of url.searchParams.getAll(key)) params.append(key, value);
  const search = params.toString();
  return search ? `?${search}` : "";
}

/**
 * The in-app route a prompt link opens, or null for anything that is not one. Only `new` and
 * `thread/<id>` are routes; every other host or path is refused so a link cannot reach Settings
 * or any other screen.
 */
export function promptLinkAppPath(value: string): string | null {
  if (!URL.canParse(value) || DOT_SEGMENT.test(value)) return null;
  const url = new URL(value);
  if (!APP_SCHEME.test(url.protocol)) return null;
  if (url.host === "new" && (url.pathname === "" || url.pathname === "/"))
    return `/new${allowedSearch(url, NEW_LINK_PARAMS)}`;
  const thread = url.host === "thread" ? THREAD_ID.exec(url.pathname) : null;
  return thread?.[1] && !RESERVED_ROUTES.has(thread[1])
    ? `/${thread[1]}${allowedSearch(url, THREAD_LINK_PARAMS)}`
    : null;
}
