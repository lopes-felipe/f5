# September 2026 upstream port classification

> Historical report. Later Phase 0 work supersedes the unfinished-prerequisite and
> rolling-window statements below; see [the Phase 0 validation report](phase-zero-validation.md).

> Historical schema-5 report. Storage and refresh mechanics are superseded by
> [the schema-6 ledger](../scripts.md#upstream-port-ledger); classification decisions remain preserved.

This completes the classification and pinned refresh portion of Phase 0b. It does
not implement the selected runtime or UX ports. Phase 0d's performance baseline
and Phases 1–14 remain unfinished; the protocol gate landed separately.

## Reproducible interval

- Baseline used for f5 comparison: `290d261c9c9daa0c469b312d7f62dfd4ea9b9698`.
- Excluded base: `9fd788b5a92254a2afa72c2a53513ed2cb730f0d`.
- Included target: `f5ef0ddb90a8c36584e181b1913e7b8a5df30ffc`.
- Selection: 1,836 first-parent commits, newest first.
- SHA-list digest (UTF-8, one full SHA per line, final newline):
  `1c3e22afe6a0fb44248d6148f254602a1cb19a3e6bd0bb573caa1afd01def3d8`.

The source decisions are in
[`scripts/upstream-port-plan-2026-09.json`](../../scripts/upstream-port-plan-2026-09.json).
Every SHA has an explicit disposition and a reason. Commit subjects across the
full interval were reviewed against the merged scope. Changed-file lists and
patches were inspected for selected ambiguous and mixed-scope commits;
existing-equivalent claims were checked against f5 code and Git history. This is
scope triage, not a claim that every patch has been implementation-reviewed.
Each later port must inspect its upstream implementation and follow-up fixes,
reproduce any verify-first issue, and pass its phase's gates.

| Classification                              | Commits |
| ------------------------------------------- | ------: |
| Planned, recorded as deferred in the ledger |     875 |
| Existing f5 equivalent                      |       7 |
| Declined                                    |      42 |
| Deferred, not selected                      |     156 |
| Not applicable                              |     756 |
| Total                                       |   1,836 |

No new record is marked `ported`. Equivalent records cite file:line evidence and
existing f5 commits. Reapplying the plan preserves completed dispositions and
proof. Do not treat a planned workstream as proof of delivery.

## Scope details

The user added two features during this review:

- `8d7c700c1`: background repository cloning, Phase 3f project UX.
- `6f00d3881`: per-thread panel widths, Phase 3e timeline/file-panel UX.

Related clone-destination and panel-resizing fixes are assigned to those phases.
Both additions remain unimplemented.

For mixed commits, the reason identifies the applicable subset. For example,
`24b711b7f` retains Forgejo response/error handling but excludes the mobile
terminal edit; `ce4712d5b` retains web rendering, HTML freshness and live-event
budgets but excludes mobile outbox and marketing edits. Native platform capture
remains subject to Phase 13d's dependency review. Composer collapse uses the
final scroll behavior, never blur alone.

f5 retains its model catalogs and aliases, permissions, account/profile isolation,
durable queue, compaction, workflows, Plan mode and display profiles. Automatic
pull, cleanup, restart continuation and proactive behavior remain off by default.
The classification changes no capabilities, protocol version or runtime defaults.

## Ledger accounting

The new frozen window has 500 entries. The audit interval has another 1,336
historical entries: 1,322 newly classified older commits and the 14 commits above
the previously ported base that were already in the old window. The ledger also
retains 486 legacy records preceding the audit interval, with their original
reasons and proof. Thus `historicalEntries` has 1,822 records overall. Legacy
backlog categories remain provenance and do not double-count promoted SHAs.

The 14 existing interval records were reclassified individually; their prior
dispositions were not all deferred. The before/after Git diff remains their
change history.

## Rebuild and verification

From a checkout with the read-only `upstream` remote:

```sh
bun scripts/check-upstream-ports.ts --refresh --head f5ef0ddb90a8c36584e181b1913e7b8a5df30ffc
bun scripts/generate-upstream-gap.ts
F5_REQUIRE_UPSTREAM=1 bun run upstream-ports:check
```

The online validator compares the ordered interval with
`refs/remotes/upstream/main`. The artifact tests independently pin the interval's
digest, require regeneration to be idempotent, retain older records, and reject
a missing classification outside the 500-commit window. Planned items only move
to `ported` after implementation, required validation and real f5 commits exist.

## Planned workstream counts

A commit is counted once under its primary workstream. Mixed-scope reasons can
also identify another phase. These are commit counts, not feature estimates.

| Phase | Commits |
| ----- | ------: |
| 1a    |      22 |
| 1b    |      33 |
| 1c    |      77 |
| 1d    |      28 |
| 2     |      92 |
| 3b    |      22 |
| 3c    |      36 |
| 3d    |      12 |
| 3e    |      81 |
| 3f    |      42 |
| 4     |      40 |
| 5     |      20 |
| 6     |      15 |
| 7a    |       1 |
| 7b    |      18 |
| 7c    |      23 |
| 8a    |       1 |
| 8b    |       5 |
| 8c    |       4 |
| 8d    |       4 |
| 9b    |       2 |
| 9c    |      12 |
| 9d    |       1 |
| 9e    |       1 |
| 9f    |       2 |
| 10    |      30 |
| 11a   |      36 |
| 11b   |       1 |
| 11c   |       4 |
| 12a   |     106 |
| 12b   |       7 |
| 13a   |       2 |
| 13b   |      47 |
| 13c   |       6 |
| 13d   |       5 |
| 14    |      37 |
