export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

export interface TimelineRowIndexSource {
  readonly id: string;
  readonly groupedEntryIds?: ReadonlyArray<string>;
}

export function buildTimelineEntryRowIndexMap(
  rows: ReadonlyArray<TimelineRowIndexSource>,
): Map<string, number> {
  const map = new Map<string, number>();
  rows.forEach((row, index) => {
    map.set(row.id, index);
    for (const entryId of row.groupedEntryIds ?? []) map.set(entryId, index);
  });
  return map;
}

function evenlySample(values: ReadonlyArray<number>, count: number): number[] {
  if (values.length <= count) return [...values];
  if (count <= 1) return values.length > 0 ? [values[0]!] : [];
  const result: number[] = [];
  for (let index = 0; index < count; index += 1) {
    result.push(values[Math.round((index * (values.length - 1)) / (count - 1))]!);
  }
  return [...new Set(result)];
}

export function sampleTimelineMinimapRowIndices(input: {
  readonly rowCount: number;
  readonly boundaryIndices: ReadonlyArray<number>;
  readonly activeRowIndex: number;
  readonly maxMarkers?: number;
}): number[] {
  const maxMarkers = Math.max(2, input.maxMarkers ?? 200);
  if (input.rowCount <= 0) return [];
  if (input.rowCount <= maxMarkers) {
    return Array.from({ length: input.rowCount }, (_, index) => index);
  }

  const last = input.rowCount - 1;
  const active = Math.min(last, Math.max(0, input.activeRowIndex));
  const mandatory = [
    0,
    ...input.boundaryIndices.filter((index) => index > 0 && index < last),
    active,
    last,
  ].sort((left, right) => left - right);
  const uniqueMandatory = [...new Set(mandatory)];
  const anchors = [...new Set([0, active, last])];
  const keptMandatory =
    uniqueMandatory.length <= maxMarkers
      ? uniqueMandatory
      : [
          ...anchors,
          ...evenlySample(
            uniqueMandatory.filter((index) => !anchors.includes(index)),
            maxMarkers - anchors.length,
          ),
        ].sort((left, right) => left - right);
  if (keptMandatory.length >= maxMarkers) return keptMandatory;

  const remaining = maxMarkers - keptMandatory.length;
  const mandatorySet = new Set(keptMandatory);
  const candidates = Array.from({ length: input.rowCount }, (_, index) => index).filter(
    (index) => !mandatorySet.has(index),
  );
  return [...keptMandatory, ...evenlySample(candidates, remaining)].sort(
    (left, right) => left - right,
  );
}

export function findNearestMinimapMarkerIndex(
  markerRowIndices: ReadonlyArray<number>,
  targetRowIndex: number,
): number {
  if (markerRowIndices.length === 0) return -1;
  let low = 0;
  let high = markerRowIndices.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const value = markerRowIndices[middle]!;
    if (value === targetRowIndex) return middle;
    if (value < targetRowIndex) low = middle + 1;
    else high = middle - 1;
  }
  if (low >= markerRowIndices.length) return markerRowIndices.length - 1;
  if (high < 0) return 0;
  return targetRowIndex - markerRowIndices[high]! <= markerRowIndices[low]! - targetRowIndex
    ? high
    : low;
}
