export {
  DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
  estimateModelContextWindowTokens,
  roughTokenEstimateFromCharacters,
} from "@t3tools/shared/model";

export function isReadOnlyToolName(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "read" ||
    normalized === "view" ||
    normalized === "open" ||
    normalized.startsWith("read_") ||
    normalized.startsWith("view_") ||
    normalized.startsWith("open_") ||
    normalized.endsWith("_read") ||
    normalized.endsWith(".read") ||
    normalized.endsWith(".view") ||
    normalized.endsWith(".open")
  );
}
