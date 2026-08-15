import type { SettingsCategory } from "./settingsCategories";

export interface SettingsItemDescriptor {
  readonly id: string;
  readonly category: SettingsCategory;
  readonly label: string;
  readonly description: string;
  readonly keywords: ReadonlyArray<string>;
  readonly targetSelector: string;
  readonly projectScoped?: boolean;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function searchSettingsItems(
  descriptors: ReadonlyArray<SettingsItemDescriptor>,
  query: string,
  limit = 24,
): SettingsItemDescriptor[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);

  return descriptors
    .map((descriptor, sourceIndex) => {
      const normalizedLabel = normalizeSearchText(descriptor.label);
      const normalizedDescription = normalizeSearchText(descriptor.description);
      const normalizedKeywords = descriptor.keywords.map(normalizeSearchText);
      const searchable = [normalizedLabel, normalizedDescription, ...normalizedKeywords];
      if (!tokens.every((token) => searchable.some((candidate) => candidate.includes(token)))) {
        return null;
      }
      let score = 0;
      if (normalizedLabel === normalizedQuery) score += 1_000;
      if (normalizedLabel.startsWith(normalizedQuery)) score += 500;
      if (normalizedLabel.includes(normalizedQuery)) score += 250;
      for (const token of tokens) {
        if (normalizedLabel.split(" ").some((word) => word.startsWith(token))) score += 80;
        if (normalizedDescription.includes(token)) score += 20;
        if (normalizedKeywords.some((keyword) => keyword === token)) score += 60;
        else if (normalizedKeywords.some((keyword) => keyword.includes(token))) score += 30;
      }
      return { descriptor, score, sourceIndex };
    })
    .filter((candidate) => candidate !== null)
    .toSorted((left, right) => right.score - left.score || left.sourceIndex - right.sourceIndex)
    .slice(0, Math.max(0, limit))
    .map(({ descriptor }) => descriptor);
}
