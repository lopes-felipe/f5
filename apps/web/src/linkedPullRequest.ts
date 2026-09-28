import type { ThreadPullRequestLink } from "@t3tools/contracts";

/** Git actions currently use GitHub, including configured Enterprise hosts. */
export function githubThreadLink(url: string, title: string): ThreadPullRequestLink | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/.exec(parsed.pathname);
    if (!match) return null;
    const number = Number(match[3]);
    if (!Number.isSafeInteger(number)) return null;
    return {
      provider: "github",
      host: parsed.host,
      repository: `${match[1]}/${match[2]}`,
      number,
      title: title.trim().slice(0, 1000) || `PR #${number}`,
      url: parsed.href,
    };
  } catch {
    return null;
  }
}
