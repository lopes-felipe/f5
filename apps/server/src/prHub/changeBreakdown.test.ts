import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { PrHubFilesPage } from "@t3tools/contracts";
import { readChangeBreakdown } from "./changeBreakdown";

function page(path: string, more = false): PrHubFilesPage {
  return {
    files: [{ path, changeType: "changed", additions: 4, deletions: 2 }],
    pageInfo: { hasNextPage: more, endCursor: more ? "next" : null, truncated: false },
    stale: false,
    refreshedAt: "2026-11-22T00:00:00.000Z",
  };
}
describe("PR change breakdown", () => {
  it("sums all pages by kind", async () => {
    const result = await Effect.runPromise(
      readChangeBreakdown((cursor) =>
        Effect.succeed(cursor ? page("test/a.test.ts") : page("src/a.ts", true)),
      ),
    );
    expect(result?.code).toEqual({ additions: 4, deletions: 2 });
    expect(result?.tests).toEqual({ additions: 4, deletions: 2 });
    expect(result?.docs).toEqual({ additions: 0, deletions: 0 });
  });
  it("refuses capped pages and repeated cursors instead of showing partial totals", async () => {
    expect(
      await Effect.runPromise(
        readChangeBreakdown(() =>
          Effect.succeed({
            ...page("a"),
            pageInfo: { hasNextPage: false, endCursor: null, truncated: true },
          }),
        ),
      ),
    ).toBeNull();
    expect(
      await Effect.runPromise(
        readChangeBreakdown(() => Effect.succeed({ ...page("a"), providerCapped: true })),
      ),
    ).toBeNull();
    expect(
      await Effect.runPromise(readChangeBreakdown(() => Effect.succeed(page("a", true)))),
    ).toBeNull();
  });
});
