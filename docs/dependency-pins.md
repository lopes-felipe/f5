# Prerelease dependency pins

One runtime dependency family remains pinned to prerelease builds (`@pierre/diffs` and `@legendapp/list` have moved to tagged stable releases). This page records what is pinned, what moving costs, and a proposed order with dates. The dates are proposals: change them here when the plan changes, so the page stays the record.

## What is pinned

Checked against the npm registry on 2026-11-25.

| Dependency                                                 | Pinned                                                           | Latest tagged | Patch                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------- | ------------- | ---------------------------------------------- |
| `effect` and four `@effect/*` packages in the root catalog | pkg.pr.new builds of `Effect-TS/effect-smol` at commit `8881a9b` | `4.1.5`       | `@effect%2Fplatform-node-shared@8881a9b.patch` |

Completed prerelease exits:

- **`@pierre/diffs`**: moved from `1.1.0-beta.19` to stable `1.5.2` (still carries `@pierre%2Fdiffs@1.5.2.patch`; track dropping the patch on the next `1.6.x` bump).
- **`@legendapp/list`**: moved from `3.0.0-beta.44` to stable `3.7.3` (no patch required; pinned to mature `3.7.3` rather than newly published `3.9.0`; initial entry JS unchanged at 315 KB, on-demand `@legendapp/list/react` route chunk is 158.8 KB / 50.1 KB gzip; verified against the Chromium browser suites including `MessagesTimeline`, `TimelineNavigation`, `DegradedStates`, `PrPageContent`, `PrDetailsTabs`, and `ChatView`).

The four are `@effect/platform-node`, `@effect/openapi-generator`, `@effect/sql-sqlite-bun` and `@effect/vitest`. `@effect/language-service` in the same catalog is a registry release. The patched `@effect/platform-node-shared` is not in the catalog: it comes in through `@effect/platform-node`. The Effect pin was already in the repository's first commit (2026-04-24), so when it was chosen is not recorded here.

The patches and how to regenerate them are described in [`patches/README.md`](../patches/README.md).

## Why move

- A pkg.pr.new URL is a preview build of one commit, not a registry release. Nothing announces a fix or a vulnerability for it, and `bun patch --commit` cannot address it, so the Effect patch is maintained by hand.
- The repository imports Effect's `unstable` modules in about 540 files (`effect/unstable/sql/SqlClient` alone in about 450, `effect/unstable/process` in about 60). The longer the pin stays, the further those APIs move and the larger the one-time migration gets. To count again: `grep -rlE "from ['\"]effect/unstable" apps packages scripts --include='*.ts' --include='*.tsx' | wc -l`.
- Each patch is written against one exact build and has to be derived again on every bump.

## Proposed order

1. **`@pierre/diffs` to 1.6.x (patch retirement), by 2026-12-15.** Check whether the release renders collapsed file headers without building a diff AST. If it does, drop `@pierre%2Fdiffs@1.5.2.patch`; if not, regenerate it against the new build. Gate: `CollapsedDiff.browser.ts`, the web browser suite and the bundle budget.
2. **Effect to 4.1.x, by 2027-01-31.** The largest remaining pin: about 1,450 files import `effect` or an `@effect/*` package.
   1. Bump the catalog on a branch and fix `bun typecheck`. Expect most of the work in `effect/unstable/sql`, `effect/unstable/process` and `effect/unstable/rpc`.
   2. Check the release against each of the three things the patch changes (see the patch notes): the `error` listener on child stdin, the same listener on input file descriptors, and `NodeSink` failing a pending write when the stream errors, closes or is destroyed while it waits for `drain` or `finish`. `apps/server/src/spawn/childStdin.test.ts` covers the stdin path only, so read the release's `NodeChildProcessSpawner` and `NodeSink` for the other two. F5 passes no extra input file descriptors today, so that guard matters only once it does. Drop the patch if all three hold and the test passes without it; otherwise port it and re-key `patchedDependencies`.
   3. Run `bun run test:full`. Then take `perf:server` and `perf:interactive` reports on the commit before the bump and on the bump, and compare each pair with `perf:compare`, as [performance.md](performance.md) describes.
   4. Release it with no other change, so a regression is attributable.

Do the three in separate PRs. None of them belongs in a feature PR.

## When a pin has to stay

If a move is blocked, write the blocker and a new date under the item above. A pin with no date and no blocker is the state this page exists to prevent.
