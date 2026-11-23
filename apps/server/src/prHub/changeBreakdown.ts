import { Effect } from "effect";
import type { PrHubChangeBreakdown, PrHubFilesPage } from "@t3tools/contracts";
import { classifyChangedFile } from "@t3tools/shared/changedFileKind";
import type { SourceControlProviderError } from "../sourceControl/SourceControlProvider";

/** Never show a partial sum as a complete breakdown. Pages must describe the same revision. */
export function readChangeBreakdown(
  read: (cursor?: string) => Effect.Effect<PrHubFilesPage, SourceControlProviderError>,
) {
  return Effect.gen(function* () {
    const totals: PrHubChangeBreakdown = {
      code: { additions: 0, deletions: 0 },
      tests: { additions: 0, deletions: 0 },
      mocks: { additions: 0, deletions: 0 },
      generated: { additions: 0, deletions: 0 },
      docs: { additions: 0, deletions: 0 },
    };
    const sums = new Map(Object.entries(totals).map(([kind, counts]) => [kind, { ...counts }]));
    const cursors = new Set<string>();
    const paths = new Set<string>();
    let cursor: string | undefined;
    let revision: string | undefined;
    for (let index = 0; index < 30; index++) {
      const page = yield* read(cursor);
      const nextRevision = JSON.stringify(page.comparison);
      if (
        page.stale ||
        page.providerCapped ||
        page.pageInfo.truncated ||
        page.warning ||
        (index > 0 && revision !== nextRevision)
      )
        return null;
      revision = nextRevision;
      for (const file of page.files) {
        if (paths.has(file.path)) return null;
        paths.add(file.path);
        const sum = sums.get(classifyChangedFile(file.path))!;
        sum.additions += file.additions;
        sum.deletions += file.deletions;
      }
      if (!page.pageInfo.hasNextPage) {
        return Object.fromEntries(sums) as PrHubChangeBreakdown;
      }
      cursor = page.pageInfo.endCursor ?? undefined;
      if (!cursor || cursors.has(cursor)) return null;
      cursors.add(cursor);
    }
    return null;
  });
}
