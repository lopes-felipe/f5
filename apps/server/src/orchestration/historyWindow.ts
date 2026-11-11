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
    if (
      count > 0 &&
      (count >= 125 || (turns >= 10 && (!forward || isUserTurn(row))) || bytes + size > 258_048)
    )
      break;
    bytes += size;
    if (isUserTurn(row)) turns++;
    count++;
  }
  return forward ? rows.slice(0, count) : rows.slice(rows.length - count);
}

export function boundedHistoryStreams<
  T extends {
    messages: ReadonlyArray<{ role: string; createdAt?: string; turnId?: string | null }>;
    checkpoints: ReadonlyArray<unknown>;
    activities: ReadonlyArray<unknown>;
    commandExecutions: ReadonlyArray<unknown>;
    hasOlderMessages: boolean;
    hasOlderCheckpoints: boolean;
    hasOlderActivities: boolean;
    hasOlderCommandExecutions: boolean;
  },
>(input: T, forwardMessages = false, forwardActivities = false) {
  const messages = boundedHistoryRows(
    input.messages,
    forwardMessages,
    (row) => row.role === "user",
  );
  // Forward pages extend an existing window that already has older messages.
  const oldest = forwardMessages || forwardActivities ? undefined : messages[0];
  const inWindow = (value: unknown) => {
    const row = value as {
      turnId?: string | null;
      createdAt?: string;
      startedAt?: string;
      completedAt?: string;
    };
    const timestamp = row.createdAt ?? row.startedAt ?? row.completedAt;
    return (
      !oldest?.createdAt ||
      !timestamp ||
      (oldest.turnId != null && row.turnId === oldest.turnId) ||
      timestamp >= oldest.createdAt
    );
  };
  const checkpointRows = boundedHistoryRows(input.checkpoints);
  const activityRows = boundedHistoryRows(input.activities, forwardActivities);
  const commandRows = boundedHistoryRows(input.commandExecutions);
  // Sequence/turn-count cursors need contiguous suffixes. Clock skew must not
  // create holes after the first retained row that the next page cannot reach.
  const align = <Row>(rows: ReadonlyArray<Row>) => {
    const start = rows.findIndex(inWindow);
    return start < 0 ? [] : rows.slice(start);
  };
  const checkpoints = align(checkpointRows);
  const activities = align(activityRows);
  const commandExecutions = align(commandRows);
  return {
    ...input,
    messages,
    checkpoints,
    activities,
    commandExecutions,
    // Empty aligned streams still need a continuation immediately above the
    // newest deferred row. Otherwise the client cannot request that history.
    deferredCheckpoint:
      checkpoints.length === 0
        ? (checkpointRows.at(-1) as T["checkpoints"][number] | undefined)
        : undefined,
    deferredActivity:
      activities.length === 0
        ? (activityRows.at(-1) as T["activities"][number] | undefined)
        : undefined,
    deferredCommandExecution:
      commandExecutions.length === 0
        ? (commandRows.at(-1) as T["commandExecutions"][number] | undefined)
        : undefined,
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
