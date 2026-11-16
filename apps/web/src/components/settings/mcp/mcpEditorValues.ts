export type McpKeyValueRow = {
  key: string;
  value: string;
  secret?: boolean;
  replacing?: boolean;
  previousValue?: string;
};
export function readMcpKeyValueRows(text: string): McpKeyValueRow[] {
  if (!text) return [];
  if (text.trim().startsWith("[")) return JSON.parse(text) as McpKeyValueRow[];
  if (text.trim().startsWith("{"))
    return Object.entries(JSON.parse(text) as Record<string, string>).map(([key, value]) => ({
      key,
      value,
    }));
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf("=");
      return index < 0
        ? { key: line, value: "" }
        : { key: line.slice(0, index), value: line.slice(index + 1) };
    });
}

export function mcpDuplicateKeys(rows: readonly McpKeyValueRow[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (key && seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return duplicates;
}
