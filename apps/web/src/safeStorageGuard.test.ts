import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>(
  ["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}", "!./**/*.browser.{ts,tsx}"],
  { query: "?raw", import: "default", eager: true },
);

/**
 * Ratchet allowlist for pre-existing guarded `localStorage` write sites pending
 * migration to `apps/web/src/lib/safeStorage.ts`. New code must use
 * `safeLocalStorageSetItem` / `safeLocalStorageRemoveItem` instead.
 */
const LEGACY_LOCAL_STORAGE_WRITE_FILES = new Set([
  "components/RepositoryPicker.tsx",
  "components/chat/UserMessageRevertPopover.tsx",
  "components/prHub/PrQueueView.tsx",
  "components/usage/ResetCreditButton.tsx",
  "hooks/useMigrateClientSettings.ts",
  "hooks/useServerUpdateOutcome.ts",
  "notificationCenter/inboxStore.ts",
  "routes/_chat.tsx",
  "store.ts",
]);

const DIRECT_LOCAL_STORAGE_WRITE = /\blocalStorage\.(?:setItem|removeItem)\s*\(/;

describe("safeStorage guard", () => {
  it("prevents new direct localStorage.setItem/removeItem calls outside safeStorage.ts", () => {
    const violations: string[] = [];
    for (const [key, source] of Object.entries(sources)) {
      const relativePath = key.replace(/^\.\//, "");
      if (relativePath === "lib/safeStorage.ts") continue;
      if (LEGACY_LOCAL_STORAGE_WRITE_FILES.has(relativePath)) continue;
      if (DIRECT_LOCAL_STORAGE_WRITE.test(source)) {
        violations.push(relativePath);
      }
    }
    expect(
      violations,
      "Use safeLocalStorageSetItem / safeLocalStorageRemoveItem from ~/lib/safeStorage instead of direct localStorage writes.",
    ).toEqual([]);
  });
});
