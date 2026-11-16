const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export function formatUpstreamInboxTitle(count: number): string {
  return `Upstream: ${plural(count, "new topic")} to review`;
}

export function formatUpstreamAutoQueuedTitle(count: number): string {
  return `Upstream: auto-queued ${plural(count, "port")}`;
}

export function formatUpstreamDigestTitle(digest: {
  readonly followed: number;
  readonly other: number;
}): string {
  const total = digest.followed + digest.other;
  return `Upstream: ${plural(total, "new feature")} this week${
    digest.followed > 0 ? ` (${digest.followed} in followed areas)` : ""
  }`;
}
