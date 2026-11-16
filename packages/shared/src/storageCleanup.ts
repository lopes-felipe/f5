import type { StorageCleanupCategoryId, StorageCleanupCategoryUsage } from "@t3tools/contracts";
export const TYPED_CONFIRM_THRESHOLD_BYTES = 1024 * 1024 * 1024;
export function selectedCategoryBytes(input: {
  readonly category: StorageCleanupCategoryUsage;
  readonly selectedTargetIds?: ReadonlySet<string> | undefined;
}): number {
  if (input.category.id === "databaseVacuum") return input.category.bytes;
  if (input.selectedTargetIds !== undefined || input.category.targets.length > 0) {
    return input.category.targets
      .filter((target) => input.selectedTargetIds?.has(target.id) ?? target.safeToDelete)
      .reduce((total, target) => total + target.bytes, 0);
  }
  return input.category.reclaimableBytes;
}

export function cleanupRequiresTypedDelete(input: {
  readonly categories: ReadonlyArray<StorageCleanupCategoryUsage>;
  readonly targetSelections: ReadonlyMap<StorageCleanupCategoryId, ReadonlySet<string>>;
}): boolean {
  const totalBytes = input.categories.reduce(
    (total, category) =>
      total +
      selectedCategoryBytes({
        category,
        selectedTargetIds: input.targetSelections.get(category.id),
      }),
    0,
  );
  return (
    totalBytes > TYPED_CONFIRM_THRESHOLD_BYTES ||
    input.categories.some((category) => category.impact === "high")
  );
}
