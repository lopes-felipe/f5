const OPENING_TAG = "<proposed_plan>";
const CLOSING_TAG = "</proposed_plan>";

function normalizedDelimiter(line: string): string {
  return line.trim().toLowerCase();
}

function outerDelimiterIndexes(lines: ReadonlyArray<string>): {
  readonly openings: ReadonlyArray<number>;
  readonly closings: ReadonlyArray<number>;
} {
  const openings: number[] = [];
  const closings: number[] = [];
  let fence: { readonly marker: "`" | "~"; readonly length: number } | null = null;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (fence) {
      const closingFence = new RegExp(`^\\${fence.marker}{${fence.length},}\\s*$`);
      if (closingFence.test(trimmed)) fence = null;
      continue;
    }
    const openingFence = /^(?<marker>`{3,}|~{3,})/.exec(trimmed)?.groups?.marker;
    if (openingFence) {
      fence = {
        marker: openingFence[0] as "`" | "~",
        length: openingFence.length,
      };
      continue;
    }
    const delimiter = normalizedDelimiter(line);
    if (delimiter === OPENING_TAG) openings.push(index);
    if (delimiter === CLOSING_TAG) closings.push(index);
  }
  return { openings, closings };
}

/**
 * Extract the outer proposed-plan wrapper from provider output.
 *
 * Delimiters are recognized only when they occupy a complete line. The first
 * opening delimiter and last closing delimiter form the outer span so plans
 * may safely quote the same tags in examples or fenced code blocks.
 */
export function extractProposedPlanMarkdown(text: string | null | undefined): string | undefined {
  if (!text) {
    return undefined;
  }

  const lines = text.split(/\r?\n/);
  const delimiters = outerDelimiterIndexes(lines);
  const openingIndex = delimiters.openings.at(0);
  if (openingIndex === undefined) {
    return undefined;
  }
  const closingIndex = delimiters.closings.findLast((index) => index > openingIndex);
  if (closingIndex === undefined) {
    return undefined;
  }

  const markdown = lines
    .slice(openingIndex + 1, closingIndex)
    .join("\n")
    .trim();
  return markdown.length > 0 ? markdown : undefined;
}

export type ProposedPlanValidationResult =
  | { readonly valid: true; readonly markdown: string }
  | { readonly valid: false; readonly error: string };

/** Validates the strict workflow wrapper contract used by v2 planning stages. */
export function validateProposedPlanOutput(
  text: string | null | undefined,
): ProposedPlanValidationResult {
  if (!text || text.trim().length === 0) {
    return { valid: false, error: "The response was empty." };
  }

  const lines = text.split(/\r?\n/);
  const delimiters = outerDelimiterIndexes(lines);
  if (delimiters.openings.length !== 1 || delimiters.closings.length !== 1) {
    return {
      valid: false,
      error:
        "The response must contain exactly one line-delimited <proposed_plan> wrapper outside fenced code blocks.",
    };
  }
  const nonWhitespaceIndexes = lines
    .map((line, index) => (line.trim().length > 0 ? index : -1))
    .filter((index) => index >= 0);
  const firstIndex = nonWhitespaceIndexes.at(0);
  const lastIndex = nonWhitespaceIndexes.at(-1);
  if (firstIndex === undefined || lastIndex === undefined) {
    return { valid: false, error: "The response was empty." };
  }
  if (normalizedDelimiter(lines[firstIndex] ?? "") !== OPENING_TAG) {
    return {
      valid: false,
      error: "The first non-whitespace line must be <proposed_plan>.",
    };
  }
  if (normalizedDelimiter(lines[lastIndex] ?? "") !== CLOSING_TAG) {
    return {
      valid: false,
      error: "The last non-whitespace line must be </proposed_plan>.",
    };
  }
  if (delimiters.openings[0] !== firstIndex || delimiters.closings[0] !== lastIndex) {
    return {
      valid: false,
      error: "The proposed plan wrapper delimiters were malformed.",
    };
  }

  const markdown = lines
    .slice(firstIndex + 1, lastIndex)
    .join("\n")
    .trim();
  if (markdown.length === 0) {
    return { valid: false, error: "The proposed plan block was empty." };
  }
  return { valid: true, markdown };
}

/** Removes line-delimited proposed-plan wrapper tags without changing content. */
export function stripProposedPlanBlockTags(text: string): string {
  const lines = text.split(/\r?\n/);
  const delimiters = outerDelimiterIndexes(lines);
  const wrapperIndexes = new Set([...delimiters.openings, ...delimiters.closings]);
  return lines
    .filter((_line, index) => !wrapperIndexes.has(index))
    .join("\n")
    .trim();
}
