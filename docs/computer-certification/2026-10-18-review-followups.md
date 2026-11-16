# Computer control review follow-ups

This records the changes made after the Author A and Author B reviews. It supplements
[the original verification record](2026-10-18-computer-followups-verification.md).
No certification gate was opened.

## Findings and decisions

| Review | Change or decision                                                                                                                                                                                                                                                                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1     | Capture the geometry epoch after the admitted action invalidates prior observations, immediately before dispatch. Subsequent invalidations still reject that capture. The HTTP integration covers screenshot → click → click without another screenshot.                                                                                                                             |
| A2     | Both adapters classify the actual notification's `sessionUpdate` before mapping events, independently of native logging. Tests exercise unseen update-only calls with logging disabled in Cursor, Grok and the shared Antigravity adapter.                                                                                                                                           |
| A3     | Classified calls bypass both Grok and Antigravity task extraction. The adapter tests assert that private task output produces neither task events nor persisted content.                                                                                                                                                                                                             |
| A4     | Turn completion records the ended turn and cancels an unpinned startup waiter. The regression holds initial context resolution, ends the turn and verifies immediate interruption and rejection after resolution.                                                                                                                                                                    |
| B1     | Added frozen per-harness preview verification flags, all false. Production sessions install no preview catalog until verification. The live startup/inventory suite uses an injected test override and never changes production flags.                                                                                                                                               |
| B2     | Runtime, authentication and spawn errors retain bounded, scrubbed messages. Only new/load/resume setup failures receive fixed codes. A weak, in-memory record preserves error origin across startup/fallback handling without changing internal retry classification. Raw causes are omitted.                                                                                        |
| B3     | The preparer already checked provenance, but an incoming `computerTool` flag could survive that check. It now strips incoming flags. Ingestion accepts only authenticated provenance or private admission evidence, carried across the server's in-memory queue. A third-party `computer_click` with a forged flag stays generic, including after queue admission.                   |
| B4     | Successful Stop clears its flag when no held lease or pending takeover remains. Failures and held leases still require authoritative release. Added the no-lease regression.                                                                                                                                                                                                         |
| B5     | Reproduced all ten previously unclassified failures on untouched `main` under a clean environment; see the baseline comparison below.                                                                                                                                                                                                                                                |
| B6     | Removed full log-redaction passes from event publishing. Classification runs only on tool events in computer-capable sessions and on permission events. Native loggers own one redaction pass per sink; the runtime delegates to those writers rather than redacting again.                                                                                                          |
| B7     | Protocol errors retain numeric codes, human text beginning with brackets stays readable, and failed request logs use a `failure` field rather than `result`. Setup details and raw error data remain bounded to prevent echoed configuration from leaking.                                                                                                                           |
| B8     | Known native calls keep their classification on partial updates with no input, unless the update introduces suspicious tool identity or kind. Unseen update-only calls remain computer-classified, and computer IDs never revert.                                                                                                                                                    |
| B9     | Tool history receives delivery from its own dispatch callback. Concurrent calls cannot share a last-delivery value; a plain wait has no delivery badge. A concurrent completion regression covers the ordering.                                                                                                                                                                      |
| B10    | Aggregate wait start/completion preserves the last capture. Idle turn completion preserves observations; completion that cancels admitted work still invalidates it. Pause, revocation, capture failure and session disposal retain their invalidation behavior.                                                                                                                     |
| B11    | Discovery records bounded stderr and gives temporary scratch writes a separate location, excluded from persistent registration drift. The repeated probe identifies the sandbox failure and confirms unchanged operator registrations.                                                                                                                                               |
| B12    | Both verification records are frozen. Live tests inject overrides through constructor options, which production drivers leave unset.                                                                                                                                                                                                                                                 |
| B13    | Catalog callback exceptions become typed ACP failures with a fixed code. A regression verifies the failure is not an Effect defect and contains no thrown marker.                                                                                                                                                                                                                    |
| B14    | Codex receives a Codex-specific Chrome gate message. Settings uses provider display labels, derives native fallback text from live session reports and caches configuration lookup by activity-array identity. Muse's explicit configuration event is retained: it supplies the required unsupported reason, and there is no other explicit configuration publisher in that adapter. |

The prompt-redaction safeguard is also retained in computer-capable ACP sessions. The
live privacy requirement excludes the typed marker from **all** native logs; a prompt
that instructs the agent to type that marker would otherwise expose it before any tool
call. Ordinary ACP sessions do not receive that prompt redaction.

## Live probes and closed gates

The Cursor [control](2026-10-18-acp-preview-review-control.json) and
[preview-only](2026-10-18-acp-preview-review-preview.json) runs both initialized and
then hit the 25-second startup timeout during authentication, before `session/new`
sent MCP configuration. Neither produced session events or passing inventory evidence.
This locates the observed startup blocker before the catalog payload is sent; it does
not establish live preview compatibility. Preview and computer verification flags
therefore remain false for all three ACP harnesses.

The repeated [Chrome discovery](2026-10-18-claude-chrome-native-host-review.json)
records `sandbox-exec: sandbox_apply: Operation not permitted`, exit 71, no temporary
writes or registrations, and identical operator manifests. A candidate descriptor,
real Chrome certification driver, signed-build certification, complete ACP conformance,
manual desktop checks and native timing evidence remain outstanding. None can be
claimed from these probes.

## Baseline comparison

A detached baseline worktree was created at `/tmp/f5-review-baseline-f8fd15` from local
`main`, commit `f8fd15a7700f9e925c720a68ed03828d5061a014` (also the implementation base).
Dependencies were installed with `bun install --frozen-lockfile`. Test commands used
`env -i HOME="$HOME" PATH="$PATH"` in both worktrees.

- `bun run --cwd apps/server test:file src/distribution/launcher.test.ts src/wsServer.test.ts`:
  **129 passed, 5 failed** on baseline. The same three launcher failures and two Agent
  Bridge credential-file failures reproduce without this implementation.
- `bun run --cwd apps/server test:file integration/orchestrationEngine.integration.test.ts`:
  **1 passed, 5 failed, 1 skipped** on baseline. Each failed turn is rejected before
  execution because its recorded worktree does not match its repository and branch.
- `bun run --cwd scripts test upstream-port-migration.test.ts`: **13 passed, 2 failed**
  on baseline, reproducing both migration recovery failures.

Local baseline logs are `/tmp/f5-review-baseline-unit.log`,
`/tmp/f5-review-baseline-integration.log` and `/tmp/f5-review-baseline-migration.log`.

## Verification

- Focused server/adapters/catalog/cleanup run: **129 passed**. The final delivery,
  observation-preservation and logging regressions then passed **75 tests** across
  their five files.
- Provider service and runtime ingestion suites: **220 passed**.
- Web store and controls: **21 passed**.
- Exhaustive real-Git matrix: **140 passed** across all four files, run separately.
- `bun run test:full` ran and stopped at the two known migration recovery failures,
  before its Git stage. The separate exhaustive run above completed that stage.

- Final `bun fmt`, `bun lint` and `bun typecheck`: **passed**; lint reports 28 warnings
  and zero errors, and typecheck completed all eight packages.
- Chromium live-card and control coverage: **13 passed**.
- Continuing workspace run (`bun run test --continue`): server units **4,418 passed,
  5 failed, 10 skipped**; the five failures are the baseline launcher/Agent Bridge
  failures above. All other workspace packages passed except scripts, which has the
  same **301 passed, 2 migration failures**. The server unit failure prevents its
  chained integration stage, so integration was run separately.
- Separate integration suite: **18 passed, 5 failed, 18 skipped**; all five failures
  match the baseline orchestration worktree invariant failures. Both new preview-live
  cases are skipped unless explicitly enabled.
- `git diff --check`: passed.

The initial full typecheck found a new test fixture missing `frontmost` and an Effect
Schema `instanceof` diagnostic. Both were corrected; the final full typecheck passed.
Local final logs use `/tmp/f5-review-`: `typecheck-pass.log`, `lint-final.log`,
`workspace.log`, `integration-final.log`, `git-extended.log`, `browser.log`,
`focused-final.log` and `last-regressions.log`.

## PR #162 comment follow-up

The next review found production regressions beyond the earlier fixes. Setup masking is
now conditional on an installed private catalog or computer-capable lineage; ordinary
ACP sessions retain readable, credential-scrubbed details and diagnostic causes. Log
error/cause masking is likewise restricted to computer-capable sessions, while structural
MCP credential redaction and malformed-frame suppression stay universal.

Observation invalidation no longer clears pending invocation admission. A held mutation's
retry joins its result, and action invalidation preserves app resolutions. Connection
replacement and scope disposal invalidate admission explicitly. Screenshot-less actions
still invalidate coordinate evidence, now documented in model guidance.

The live-card controls wrap with both histories visible at 320 px. Cursor retains its full
configuration snapshot, including session slash commands, during catalog-status refreshes.
Lifecycle turn starts pin wait ownership; turn revisions reject work spanning transitions,
and only the latest ended turn is retained per binding. Expired requests stop raising
attention or blocking the inbox without deleting unsettled history. Ineligible ACP
sessions and non-Claude/non-Mac Chrome checks report accurate reasons.

Two requested behavior changes are intentionally declined: a failed trailing capture keeps
`computer_wait`'s `isError` result and its wait metadata, as explicitly specified in the
approved plan; remote consent attention remains available while only the host can grant
access. The broader PR scope and selective docstrings are retained; no certification gate
is opened by these fixes.

Validation for these PR-comment corrections: `bun fmt`, `bun lint` (28 warnings,
zero errors), and all eight `bun typecheck` packages passed. The focused server run
passed 301 tests across 15 files; Chromium passed 22 tests, web units passed 24,
and the exhaustive real-Git matrix passed all 140. `bun run test:full` was repeated
under `env -i HOME="$HOME" PATH="$PATH"` and stopped at the same two baseline
`upstream-port-migration.test.ts` recovery failures before reaching its Git stage;
the exhaustive matrix was therefore run separately. Logs are in `/tmp/f5-pr162-*`.
