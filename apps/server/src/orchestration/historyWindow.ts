/**
 * F5 pages four independently cursor-addressed streams. Reserve a quarter of
 * the 1 MiB window for each (less 16 KiB for metadata), and at most 125 rows each. Always make progress
 * for a single oversized row; never truncate a message or tool payload.
 */
export function boundedHistoryRows<Row>(
  rows: ReadonlyArray<Row>,
  forward = false,
  isUserTurn: (row: Row) => boolean = () => false,
): ReadonlyArray<Row> {
  let bytes = 2;
  let turns = 0;
  let count = 0;
  const ordered = forward ? rows : rows.toReversed();
  for (const row of ordered) {
    const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
    if (count > 0 && (count >= 125 || turns >= 10 || bytes + size > 258_048)) break;
    bytes += size;
    if (isUserTurn(row)) turns++;
    count++;
  }
  return forward ? rows.slice(0, count) : rows.slice(rows.length - count);
}

export function boundedHistoryStreams<
  T extends {
    messages: ReadonlyArray<{ role: string }>;
    checkpoints: ReadonlyArray<unknown>;
    activities: ReadonlyArray<unknown>;
    commandExecutions: ReadonlyArray<unknown>;
    hasOlderMessages: boolean;
    hasOlderCheckpoints: boolean;
    hasOlderActivities: boolean;
    hasOlderCommandExecutions: boolean;
  },
>(input: T, forwardMessages = false, forwardActivities = false): T {
  const messages = boundedHistoryRows(
    input.messages,
    forwardMessages,
    (row) => row.role === "user",
  );
  const checkpoints = boundedHistoryRows(input.checkpoints);
  const activities = boundedHistoryRows(input.activities, forwardActivities);
  const commandExecutions = boundedHistoryRows(input.commandExecutions);
  return {
    ...input,
    messages,
    checkpoints,
    activities,
    commandExecutions,
    hasOlderMessages:
      input.hasOlderMessages || (!forwardMessages && messages.length < input.messages.length),
    ...(forwardMessages && messages.length < input.messages.length
      ? { hasNewerMessages: true }
      : {}),
    hasOlderCheckpoints: input.hasOlderCheckpoints || checkpoints.length < input.checkpoints.length,
    hasOlderActivities:
      input.hasOlderActivities ||
      (!forwardActivities && activities.length < input.activities.length),
    ...(forwardActivities && activities.length < input.activities.length
      ? { hasNewerActivities: true }
      : {}),
    hasOlderCommandExecutions:
      input.hasOlderCommandExecutions || commandExecutions.length < input.commandExecutions.length,
  };
}
