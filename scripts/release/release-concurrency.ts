/** Drain active operations on failure, but never schedule more work after it. */
export async function releasePool<T>(
  values: readonly T[],
  operation: (value: T, index: number) => Promise<void>,
  limit = 3,
): Promise<void> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid release worker limit");
  let next = 0;
  const failures: unknown[] = [];
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (!failures.length && next < values.length) {
        const index = next++;
        try {
          await operation(values[index]!, index);
        } catch (error) {
          failures.push(error);
        }
      }
    }),
  );
  if (failures.length) throw failures[0];
}
