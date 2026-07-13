export interface ParsedGlobalSearchQuery {
  readonly text: string;
  readonly project: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly status: string | null;
  readonly dateFrom: string | null;
  readonly dateTo: string | null;
  readonly includeArchived: boolean;
}

function normalizeDate(value: string, endOfDay: boolean): string | null {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = new Date(
    dateOnly ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z` : value,
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function parseGlobalSearchQuery(input: string): ParsedGlobalSearchQuery {
  const filters = new Map<string, string>();
  const text = input
    .replace(
      /(?:^|\s)(project|provider|model|status|after|before|archived):(?:"([^"]+)"|(\S+))/giu,
      (_match, name: string, quoted: string | undefined, bare: string | undefined) => {
        filters.set(name.toLowerCase(), (quoted ?? bare ?? "").trim());
        return " ";
      },
    )
    .replace(/\s+/g, " ")
    .trim();
  const archived = filters.get("archived")?.toLowerCase();
  return {
    text,
    project: filters.get("project") ?? null,
    provider: filters.get("provider") ?? null,
    model: filters.get("model") ?? null,
    status: filters.get("status") ?? null,
    dateFrom: filters.has("after") ? normalizeDate(filters.get("after")!, false) : null,
    dateTo: filters.has("before") ? normalizeDate(filters.get("before")!, true) : null,
    includeArchived: archived === "true" || archived === "yes" || archived === "1",
  };
}
