import { type GlobalSearchQueryInput, ProviderInstanceId } from "@t3tools/contracts";

import type { Project } from "../types";

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

export function buildGlobalSearchQueryInput(input: {
  parsed: ParsedGlobalSearchQuery;
  projects: ReadonlyArray<Pick<Project, "id" | "name">>;
  limit?: number;
}): GlobalSearchQueryInput | null {
  if (input.parsed.text.length < 2) {
    return null;
  }

  const normalizedProjectFilter = input.parsed.project?.toLowerCase() ?? null;
  const project = normalizedProjectFilter
    ? input.projects.find(
        (candidate) =>
          candidate.id.toLowerCase() === normalizedProjectFilter ||
          candidate.name.toLowerCase() === normalizedProjectFilter,
      )
    : null;
  if (normalizedProjectFilter && !project) {
    return null;
  }

  let providerInstanceId: ProviderInstanceId | undefined;
  if (input.parsed.provider) {
    try {
      providerInstanceId = ProviderInstanceId.make(input.parsed.provider);
    } catch {
      return null;
    }
  }

  return {
    query: input.parsed.text,
    ...(project ? { projectId: project.id } : {}),
    ...(providerInstanceId ? { providerInstanceId } : {}),
    ...(input.parsed.model ? { model: input.parsed.model } : {}),
    ...(input.parsed.status ? { status: input.parsed.status } : {}),
    ...(input.parsed.dateFrom ? { dateFrom: input.parsed.dateFrom } : {}),
    ...(input.parsed.dateTo ? { dateTo: input.parsed.dateTo } : {}),
    ...(input.parsed.includeArchived ? { includeArchived: true } : {}),
    limit: input.limit ?? 24,
  };
}
