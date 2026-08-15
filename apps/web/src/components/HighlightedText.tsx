import { Fragment } from "react";

export interface HighlightedTextRange {
  readonly start: number;
  readonly end: number;
}

interface HighlightedTextSegment {
  readonly text: string;
  readonly highlighted: boolean;
}

function mergeRanges(
  ranges: ReadonlyArray<HighlightedTextRange>,
  textLength: number,
): HighlightedTextRange[] {
  const sorted = ranges
    .map(({ start, end }) => ({
      start: Math.max(0, Math.min(textLength, start)),
      end: Math.max(0, Math.min(textLength, end)),
    }))
    .filter(({ start, end }) => end > start)
    .toSorted((left, right) => left.start - right.start || left.end - right.end);
  const merged: HighlightedTextRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end) {
      merged.push(range);
      continue;
    }
    merged[merged.length - 1] = {
      start: previous.start,
      end: Math.max(previous.end, range.end),
    };
  }
  return merged;
}

function rangesForQuery(text: string, query: string): HighlightedTextRange[] {
  const codePoints = Array.from(text);
  const normalizedText = codePoints.join("").toLocaleLowerCase();
  const tokens = [
    ...new Set(
      query
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}_]+/gu)
        ?.filter(Boolean) ?? [],
    ),
  ].toSorted((left, right) => right.length - left.length);
  const ranges: HighlightedTextRange[] = [];
  for (const token of tokens) {
    let offset = 0;
    while (offset < normalizedText.length) {
      const matchIndex = normalizedText.indexOf(token, offset);
      if (matchIndex === -1) break;
      const start = Array.from(normalizedText.slice(0, matchIndex)).length;
      const end = start + Array.from(token).length;
      ranges.push({ start, end });
      offset = matchIndex + Math.max(1, token.length);
    }
  }
  return mergeRanges(ranges, codePoints.length);
}

export function buildHighlightedTextSegments(input: {
  text: string;
  query?: string;
  ranges?: ReadonlyArray<HighlightedTextRange>;
}): HighlightedTextSegment[] {
  const codePoints = Array.from(input.text);
  const ranges = mergeRanges(
    input.ranges ?? (input.query ? rangesForQuery(input.text, input.query) : []),
    codePoints.length,
  );
  if (ranges.length === 0) {
    return [{ text: input.text, highlighted: false }];
  }

  const segments: HighlightedTextSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      segments.push({ text: codePoints.slice(cursor, range.start).join(""), highlighted: false });
    }
    segments.push({ text: codePoints.slice(range.start, range.end).join(""), highlighted: true });
    cursor = range.end;
  }
  if (cursor < codePoints.length) {
    segments.push({ text: codePoints.slice(cursor).join(""), highlighted: false });
  }
  return segments;
}

export function HighlightedText(props: {
  text: string;
  query?: string;
  ranges?: ReadonlyArray<HighlightedTextRange>;
  highlightClassName?: string;
}) {
  const segments = buildHighlightedTextSegments(props);
  return segments.map((segment, index) =>
    segment.highlighted ? (
      <mark
        // Segments are stable for the same text/ranges; the offset is sufficient here.
        key={index}
        className={props.highlightClassName ?? "rounded-sm bg-warning/25 text-inherit"}
      >
        {segment.text}
      </mark>
    ) : (
      <Fragment key={index}>{segment.text}</Fragment>
    ),
  );
}
