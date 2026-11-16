/** Runs only in a browser isolated world; never expose these values to page script. */
export const previewSecretCollectionSource = String.raw`
  const sensitive = new Set();
  let sensitiveCharacters = 0;
  const collect = (root) => {
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) collect(element.shadowRoot);
      const field = element.localName === "input" || element.localName === "textarea";
      if (!field && !element.isContentEditable) continue;
      const security = getComputedStyle(element).getPropertyValue("-webkit-text-security");
      if (element.type !== "password" && (!security || security === "none")) continue;
      const values = field ? [element.value, element.defaultValue] : [element.textContent || ""];
      for (const value of values) {
        if (!value || !value.trim()) continue;
        if (value.length > 16_384 || sensitiveCharacters + value.length > 1_048_576)
          throw new Error("A protected field is too large to redact safely. No snapshot was taken.");
        for (const variant of [value, value.replace(/[\u200b\u00ad]/g, "").trim().replace(/\s+/g, " "), CSS.escape(value)]) {
          if (variant && !sensitive.has(variant)) {
            if (sensitive.size >= 4096 || sensitiveCharacters + variant.length > 1_048_576) throw new Error("Too many protected fields to redact safely. No snapshot was taken.");
            sensitive.add(variant); sensitiveCharacters += variant.length;
          }
        }
      }
    }
  };
  collect(document);
`;

export const previewSecretCollectionScript = `(() => {
${previewSecretCollectionSource}
return [...sensitive].sort();
})()`;

/** Includes serialized selectors and quoted accessible names, longest match first. */
export function redactPreviewSnapshot<T>(snapshot: T, secrets: ReadonlyArray<string>): T {
  if (secrets.length > 4096 || secrets.reduce((sum, value) => sum + value.length, 0) > 1_048_576)
    throw new Error("Too many protected values to redact safely. No snapshot was taken.");
  const forms = secrets
    .flatMap((value) => {
      const json = JSON.stringify(value).slice(1, -1);
      const quoted = value.replace(/[\\"\p{Cc}]/gu, (character) =>
        '\\"\b\f\n\r\t'.includes(character)
          ? JSON.stringify(character).slice(1, -1)
          : `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
      );
      return [
        ...new Set([value, json, quoted].flatMap((form) => [form, form.replaceAll("'", "''")])),
      ]
        .filter(Boolean)
        .map((form) => ({ form, short: value.length < 4 }));
    })
    .sort((a, b) => b.form.length - a.form.length);
  let pattern: RegExp | undefined;
  if (forms.length) {
    try {
      const source = forms
        .map(({ form, short }) => {
          const literal = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          return short ? `(?<![\\p{L}\\p{N}_])${literal}(?![\\p{L}\\p{N}_])` : literal;
        })
        .join("|");
      pattern = new RegExp(source, "gu");
      // V8 can defer compilation until the first one-byte/two-byte match.
      pattern.test("");
      pattern.test("•");
      pattern.lastIndex = 0;
    } catch {
      // A regex compilation error can include the protected pattern itself.
      throw new Error("Protected fields could not be redacted safely. No snapshot was taken.");
    }
  }
  const redact = (value: unknown): unknown => {
    if (typeof value === "string") {
      try {
        return pattern ? value.replace(pattern, "••••••••") : value;
      } catch {
        throw new Error("Protected fields could not be redacted safely. No snapshot was taken.");
      }
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object")
      return Object.fromEntries(
        // The host defines snapshot keys. Preserve the schema even when a
        // credential happens to equal a field name such as "tag" or "role".
        Object.entries(value).map(([key, entry]) => [key, redact(entry)]),
      );
    return value;
  };
  return redact(snapshot) as T;
}
