# Computer-control follow-up verification, 2026-10-18

This is an implementation/verification record, **not a certification report**.
The checkout is dirty and no signed installed-build certification was performed.
Base commit: `f8fd15a7700f9e925c720a68ed03828d5061a014`.
Host: macOS arm64. Claude Agent SDK: `0.3.295`.

## Delivered and gated work

- H1–H4: ACP configuration/frame/diagnostic redaction, session-owned credential scrubbing,
  correlated thumbnail freshness, explicit bulk-control failure handling and bounded request storage.
- D1–D2: 17 tool descriptions total 4,368 characters (4,424 serialized); full guidance only
  on always-loaded status, additive server instructions, and expiry-driven live-card updates.
- U1–U3: readable readiness/support rows, consent attention and deadlines, and provenance-only
  computer timeline headings. Live readiness follows notifications/configuration events.
- F1–F2: cancellable `computer_wait`, presence matching, trailing screenshots and 30-entry
  tool-sourced actions history.
- L1: shared scope lifecycle; independent agent-identity/activity-correlation negotiation;
  new agent identities cannot execute against a legacy desktop.
- I1: lazy HTTP preview catalogs for ordinary supported ACP desktop sessions. MCP configuration
  is memoized across new/load/resume/fallback paths; finalization follows producer shutdown.
- I3 scaffolding: native-only catalog installation, live policy reporting, conservative tool,
  permission and replay classification, and sanitization before enqueue. Every harness gate
  remains false. No exact-identity parser is claimed without captured live fixtures.
- C2 infrastructure: live Claude Chrome master switch, architecture/executable drift reasons,
  SDK/architecture metadata and SDK-bump guard. No candidate values were guessed.

## Probes and remaining prerequisites

[ACP capability probe](2026-10-18-acp-capability-probe.json): installed Cursor
`2026.07.09-a3815c0` advertises HTTP and SSE. Grok was unavailable. A managed
Antigravity installation was not selected. HTTP is the supported transport in this
change. I2 is deferred until an installed targeted harness demonstrates a need for it.

[Cursor live attempt](2026-10-18-acp-cursor-live.json): timed out at 150 seconds
during startup, with 12 native log records and zero session events. No fixture input
ran and no passing privacy/conformance evidence was obtained. The opt-in test reports
its missing live checks explicitly and cannot qualify a flag flip on its own.
Held foreground takeover, harness-native plan behavior and unrelated-session attribution
still need complete live conformance evidence for each harness.

[Claude Chrome discovery](2026-10-18-claude-chrome-native-host-discovery.json):
the isolated launch was rejected by the macOS sandbox before any native-host manifest
was observed. Before/after snapshots use the OS account home, independently of the
agent's isolated `HOME`, and were identical. SDK version, executable size/hash and
architecture were recorded. The temporary HOME and provider home were retained for
inspection. No authentication/network fallback or operator registration write occurred.

C1 therefore did not establish host names, target paths, browser locations, allowed
origins or a verifiable server-status shape. A candidate descriptor and C3's real Chrome
certification driver remain pending successful isolated discovery. C4 additionally
requires a clean signed installed arm64 build, a dedicated macOS user and a fresh signed-in
extension profile. C5 is prohibited until all eleven checks pass. Native action/observation
fixture timing and the manual desktop checks were not run here; the 300 ms settle delay
is unchanged.

All certification flags and registries listed in the plan remain closed/unchanged.
OpenCode, Muse, provider computer-use built-ins, Codex Chrome and Windows receive
reporting changes only.

## Automated checks

- `bun fmt`: passed.
- `bun lint`: passed (warnings remain; zero errors).
- `bun typecheck`: passed across all eight packages.
- Focused server computer/ACP/transport/Chrome regressions: 267 passed, 3 opt-in tests skipped.
- Ingestion and startup-cleanup run: 166 passed. The later interruption/retry additions and
  wait regression run passed all 45 selected tests.
- Focused web unit tests: 24 passed.
- Chromium live-card/consent/notification/bulk-control tests: 21 passed.
- Complete desktop suite: 524 passed, including all 230 computer tests.
- Exhaustive real-Git matrix: **140 passed across all four files**; it ran separately because
  `test:full` stops at the baseline workspace failure.
- `git diff --check`: passed.

The first baseline attempt could not start because dependencies were absent. After
`bun install --frozen-lockfile`, the clean-environment baseline reproduced the two
known `upstream-port-migration.test.ts` failures. `bun run test:full` was run and stopped
at those same two failures. A continuing workspace run (`bun run test --continue`) also completed so the
server suite could run despite the scripts failure: server unit results were 4,404 passed,
5 failed and 10 skipped. All six other workspace packages passed; scripts retained the two
known migration failures. All nine ACP wire/startup-cleanup tests passed in that run.

The broad server run additionally encounters `/bin/ps` permission denial in launcher tests
and missing Agent Bridge credentials in two WebSocket tests. The standalone integration
run reports five pre-execution worktree-mismatch failures in
`orchestrationEngine.integration.test.ts` (18 passed, 16 skipped). The initial baseline
stopped before these suites, so this record does not claim they were proven baseline
failures. The computer MCP integration and the modified WebSocket thumbnail test pass
individually. No unrelated security/worktree protections were bypassed to make tests green.

## Review follow-up

The [review follow-up record](2026-10-18-review-followups.md) supersedes the earlier
unclassified-failure caveat, documents the regressions fixed after review, and records
that ACP preview installation is now closed behind per-harness verification flags.
