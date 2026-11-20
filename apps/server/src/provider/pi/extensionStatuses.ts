import { stripVTControlCharacters } from "node:util";
export function updatePiExtensionStatuses(
  previous: readonly { readonly key: string; readonly text: string }[],
  event: Record<string, unknown>,
): readonly { readonly key: string; readonly text: string }[] {
  const key = event.statusKey;
  if (
    typeof key !== "string" ||
    !key.trim() ||
    key.length > 256 ||
    (event.statusText !== undefined && typeof event.statusText !== "string")
  )
    return previous;
  const text =
    typeof event.statusText === "string"
      ? stripVTControlCharacters(event.statusText.slice(0, 16384))
          .replace(/\p{Cc}/gu, " ")
          .trim()
          .slice(0, 4096)
      : "";
  const index = previous.findIndex((entry) => entry.key === key);
  if ((index < 0 && (!text || previous.length >= 32)) || previous[index]?.text === text)
    return previous;
  return !text
    ? previous.filter((entry) => entry.key !== key)
    : index < 0
      ? [...previous, { key, text }]
      : previous.map((entry) => (entry.key === key ? { key, text } : entry));
}
