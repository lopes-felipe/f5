export function formatUpstreamInboxTitle(count: number): string {
  return `Upstream: ${count} new topic${count === 1 ? "" : "s"} to review`;
}
