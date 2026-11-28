export interface ActivityOrderedThread {
  readonly id: string;
  readonly createdAt: string;
  readonly lastInteractionAt: string;
}

function compareIsoDescending(left: string, right: string): number {
  return right.localeCompare(left);
}

export function compareThreadsByActivity(
  left: ActivityOrderedThread,
  right: ActivityOrderedThread,
): number {
  return (
    compareIsoDescending(left.lastInteractionAt, right.lastInteractionAt) ||
    compareIsoDescending(left.createdAt, right.createdAt) ||
    right.id.localeCompare(left.id)
  );
}

export function sortThreadsByActivity<T extends ActivityOrderedThread>(
  threads: ReadonlyArray<T>,
): T[] {
  return threads.toSorted(compareThreadsByActivity);
}
