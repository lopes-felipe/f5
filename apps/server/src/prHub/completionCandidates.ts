import type { PrHubCompletion } from "@t3tools/contracts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Normalize only bounded host results; descriptions never become inserted text. */
export function completionCandidates(
  value: unknown,
  sigil: "@" | "#" | "!",
  query: string,
): ReadonlyArray<PrHubCompletion> {
  const root = record(value);
  const rows = Array.isArray(value) ? value : Array.isArray(root.values) ? root.values : [];
  const seen = new Set<string>();
  const needle = query.toLowerCase();
  return rows
    .slice(0, 100)
    .flatMap((row): PrHubCompletion[] => {
      const item = record(row);
      const login = text(item.login) || text(item.username);
      const number = Number(item.number ?? item.iid);
      const title = text(item.title);
      const token = sigil === "@" ? `@${login}` : `${sigil}${number}`;
      const detail = sigil === "@" ? text(item.name) : title;
      if (
        sigil === "@"
          ? !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(login)
          : !Number.isSafeInteger(number) || number <= 0
      )
        return [];
      if (
        seen.has(token) ||
        !(token.slice(1).toLowerCase().startsWith(needle) || detail.toLowerCase().includes(needle))
      )
        return [];
      seen.add(token);
      return [
        {
          token,
          label: sigil === "@" ? login : token,
          ...(detail ? { detail: detail.slice(0, 300) } : {}),
        },
      ];
    })
    .slice(0, 10);
}
