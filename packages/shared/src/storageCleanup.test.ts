import { expect, test } from "vitest";
import type { StorageCleanupCategoryUsage } from "@t3tools/contracts";
import {
  cleanupRequiresTypedDelete,
  selectedCategoryBytes,
  TYPED_CONFIRM_THRESHOLD_BYTES,
} from "./storageCleanup";
const category = (input: Partial<StorageCleanupCategoryUsage>): StorageCleanupCategoryUsage => ({
  id: "orphanAttachments",
  title: "Attachments",
  description: "Cleanup",
  section: "attachments",
  bytes: 0,
  reclaimableBytes: 0,
  defaultSelected: false,
  impact: "none",
  availability: "ready",
  targets: [],
  targetCount: 0,
  warnings: [],
  measurement: "complete",
  eligibleThreadCount: 0,
  ...input,
});
test("vacuum requires DELETE based on the full database size even when few free pages are reclaimable", () => {
  const vacuum = category({
    id: "databaseVacuum",
    bytes: TYPED_CONFIRM_THRESHOLD_BYTES + 1,
    reclaimableBytes: 4096,
  });
  expect(cleanupRequiresTypedDelete({ categories: [vacuum], targetSelections: new Map() })).toBe(
    true,
  );
  expect(selectedCategoryBytes({ category: vacuum })).toBe(vacuum.bytes);
});
test("selected target sizes and permanent impact use the same threshold on server and client", () => {
  const files = category({
    reclaimableBytes: 2 * TYPED_CONFIRM_THRESHOLD_BYTES,
    targets: [
      { id: "small", label: "Small", bytes: 1, safeToDelete: true },
      { id: "large", label: "Large", bytes: 2 * TYPED_CONFIRM_THRESHOLD_BYTES, safeToDelete: true },
    ],
  });
  expect(
    cleanupRequiresTypedDelete({
      categories: [files],
      targetSelections: new Map([[files.id, new Set(["small"])]]),
    }),
  ).toBe(false);
  expect(
    cleanupRequiresTypedDelete({
      categories: [category({ impact: "high" })],
      targetSelections: new Map(),
    }),
  ).toBe(true);
});
test("implicit eligible targets match the server's normalized manifest, including empty selections", () => {
  const files = category({
    reclaimableBytes: 0,
    targets: [
      { id: "safe", label: "Safe", bytes: TYPED_CONFIRM_THRESHOLD_BYTES + 1, safeToDelete: true },
      {
        id: "blocked",
        label: "Blocked",
        bytes: TYPED_CONFIRM_THRESHOLD_BYTES * 2,
        safeToDelete: false,
      },
    ],
  });
  expect(cleanupRequiresTypedDelete({ categories: [files], targetSelections: new Map() })).toBe(
    true,
  );
  expect(selectedCategoryBytes({ category: files, selectedTargetIds: new Set(["safe"]) })).toBe(
    selectedCategoryBytes({ category: files }),
  );
  expect(selectedCategoryBytes({ category: files, selectedTargetIds: new Set() })).toBe(0);
  const vacuum = category({ id: "databaseVacuum", bytes: TYPED_CONFIRM_THRESHOLD_BYTES + 1 });
  expect(selectedCategoryBytes({ category: vacuum, selectedTargetIds: new Set() })).toBe(
    vacuum.bytes,
  );
});
