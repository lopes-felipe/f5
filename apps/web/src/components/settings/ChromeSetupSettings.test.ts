import { describe, expect, it } from "vitest";
import { chromeRestoreMessage, orderChromeSetups } from "./ChromeSetupSettings";

describe("Chrome setup history", () => {
  it("reports busy and blocked restores as unchanged", () => {
    expect(chromeRestoreMessage({ restored: [], skipped: [], busy: true })).toContain(
      "other F5 profile",
    );
    expect(
      chromeRestoreMessage({
        restored: [],
        skipped: [],
        blockingTransactionId: "00000000-0000-0000-0000-000000000001",
      }),
    ).toContain("newer browser setup");
    expect(
      chromeRestoreMessage({
        restored: [],
        skipped: [],
        failure: "Browser control from an earlier session hasn't stopped yet.",
      }),
    ).toBe("Browser control from an earlier session hasn't stopped yet. No files were changed.");
  });

  it("describes partial results without overstating them", () => {
    expect(chromeRestoreMessage({ restored: ["a", "b"], skipped: [] })).toBe(
      "Original browser setup restored.",
    );
    const partial = chromeRestoreMessage({ restored: ["a"], skipped: ["b"], unresolved: ["c"] });
    expect(partial).toContain("Restored 1 file.");
    expect(partial).toContain("Kept 1");
    expect(partial).toContain("1 couldn't be verified");
  });

  it("lists newer setups first so blockers come before what they block", () => {
    const entry = (id: string, createdAt: string) => ({
      id,
      provider: "claude" as const,
      targetPath: "/t",
      createdAt,
      state: "launched" as const,
    });
    expect(
      orderChromeSetups([
        entry("old", "2026-01-01T00:00:00Z"),
        entry("new", "2026-02-01T00:00:00Z"),
      ]).map((value) => value.id),
    ).toEqual(["new", "old"]);
  });
});
