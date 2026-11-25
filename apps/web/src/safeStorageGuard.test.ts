import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>(
  ["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}", "!./**/*.browser.{ts,tsx}"],
  { query: "?raw", import: "default", eager: true },
);

/**
 * Per-file call-site ratchet for pre-existing `localStorage.setItem` /
 * `removeItem` calls pending migration to `apps/web/src/lib/safeStorage.ts`.
 * Any new call site—even inside an already-listed file—fails this test.
 */
const LEGACY_LOCAL_STORAGE_WRITE_COUNTS: Readonly<Record<string, number>> = {
  "components/RepositoryPicker.tsx": 1,
  "components/chat/UserMessageRevertPopover.tsx": 1,
  "components/prHub/PrQueueView.tsx": 1,
  "components/usage/ResetCreditButton.tsx": 2,
  "hooks/useMigrateClientSettings.ts": 2,
  "hooks/useServerUpdateOutcome.ts": 1,
  "pinnedThreadsStore.ts": 1,
  "routes/_chat.tsx": 1,
  "store.ts": 2,
  "threadStatusNotifications.ts": 1,
};

const DIRECT_LOCAL_STORAGE_WRITE = /\blocalStorage\.(?:setItem|removeItem)\s*\(/g;

describe("safeStorage guard", () => {
  it("prevents new direct localStorage.setItem/removeItem calls outside safeStorage.ts", () => {
    const violations: string[] = [];
    for (const [key, source] of Object.entries(sources)) {
      const relativePath = key.replace(/^\.\//, "");
      if (relativePath === "lib/safeStorage.ts") continue;
      const matches = source.match(DIRECT_LOCAL_STORAGE_WRITE) ?? [];
      const allowed = LEGACY_LOCAL_STORAGE_WRITE_COUNTS[relativePath] ?? 0;
      if (matches.length > allowed) {
        violations.push(`${relativePath} (found ${matches.length}, allowed ${allowed})`);
      }
    }
    expect(
      violations,
      "Use safeLocalStorageSetItem / safeLocalStorageRemoveItem from ~/lib/safeStorage instead of direct localStorage writes.",
    ).toEqual([]);
  });
});
