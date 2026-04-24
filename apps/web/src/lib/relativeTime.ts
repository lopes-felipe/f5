export function formatRelativeTimeLabel(iso: string): string {
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) {
    return "";
  }

  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Returns a full locale-aware absolute timestamp (e.g. "Apr 23, 2026, 2:07 PM")
 * suitable for `title` attributes so users can disambiguate fuzzy relative labels
 * like "5m ago" that collide across rows.
 */
export function formatAbsoluteTimeLabel(iso: string): string {
  const timestamp = new Date(iso);
  if (Number.isNaN(timestamp.getTime())) {
    return "";
  }
  return timestamp.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
