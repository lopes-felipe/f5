# Phase 1d: web and desktop correctness

Based on main `060aa353f9ad6840088c4895431534eb43846e99`. This closes the 28 ledger records assigned to Phase 1d: 20 ports, six existing equivalents and two upstream-only fixes. It does not complete the remaining upstream port program.

## Result

- Clipboard copy falls back when the secure Clipboard API is absent or denied, preserving the focused editor and its selection on success and failure.
- Enter does not commit settings during IME composition. Selecting a question option carries displaced typed text into the persisted thread draft. Completed or aborted turns dismiss their blocking questions with durable resolution activities.
- Bulk thread deletion continues after failures, reports the result count and keeps failed rows selected. Approval details and action rows stay inside the composer on long commands.
- File content queries refresh after checkpoint changes and workspace refreshes. Collapsed folders remain collapsed. Existing logical diff identities and unsaved file draft reconciliation remain in use.
- Preview focus dismisses host menus; portaled menus opt out of draggable window regions. Retry invalidates router loaders, and missing routes offer a Go home action.
- macOS editor discovery checks app-bundled launchers in both Applications directories. Packaged apps preserve custom Dock icons. Desktop timestamps use the OS locale; shell locale hydration preserves inherited choices and falls back to UTF-8 LC_CTYPE. Terminals advertise truecolor unless explicitly overridden.
- Uppercase configured WebSocket schemes retain TLS when deriving the HTTP origin.
- Preview MCP results are object-shaped. `preview_snapshot` accepts `save=true`, saves the exact captured PNG once, and returns `savedScreenshot` metadata from f5's existing bounded artifact store.

## Compatibility and native adaptations

Protocol version is **4**, so stale tabs follow the existing upgrade/reload flow. This is intentional: older clients silently ignore the additive snapshot-save field. The desktop locale bridge is optional for older persisted/test bridge objects. Snapshot saving defaults to false and uses opaque artifact IDs, preserving f5's existing artifact boundary instead of exposing upstream's absolute screenshot paths. Inline chat rendering and rich file viewing remain Phase 7 work.

No new settings or capability flags are introduced. Locale defaults apply only to macOS when no locale is inherited or available from the login shell. Other platforms and explicit COLORTERM values remain unchanged.

The six equivalents are: disconnected-send interaction blocking, strict HTTP(S)-only external URLs, distinct Sunday snooze presets, client prompt-length enforcement, isolated desktop main bundling, and same-origin/local favicon retrieval. The two non-applicable fixes concern upstream's type-to-focus handler and EnvironmentAuth desktop-client registry, neither of which exists in f5.

## Validation

- `bun fmt`, `bun lint`, and `bun typecheck`: passed. Existing lint and Effect diagnostics remain warnings.
- `bun run test:full`: passed, including 2,586 server unit tests, eight Git smoke tests, 16 integration tests and all 131 exhaustive Git tests. Existing skips remain visible in the runner output.
- `bun run --cwd apps/web test:browser`: 436 passed across 46 files.
- `bun run --cwd apps/desktop test`: 110 passed across 20 files.
- `bun run test:desktop-smoke`: passed on macOS with the built renderer and Electron application.
- Follow-up pending-input and timestamp unit tests: 23 passed.
- `F5_REQUIRE_UPSTREAM=1 bun run upstream-ports:check`: passed after the proof commit and ledger update; coverage remains 2,332 records, with zero pending reviews. Ledger totals are 187 ported, 40 equivalent, two already-present and 722 planned records.

Browser regressions exercise clipboard failure cleanup, composition events (including keyCode 229), uppercase WSS, and collapsed folders plus file-query invalidation. Server tests cover multiple blocking questions at completion/abort, non-object MCP results, snapshot-save forwarding, app-bundled editor launch and terminal color overrides. Desktop tests cover locale precedence, save-flag validation, and persistence of the original screenshot bytes.

The full browser run initially exposed outdated assertions that assumed a rejected Clipboard API call could not fall back. Those tests now fail both copy mechanisms when checking the error path. The new clipboard test also caught and verified a correction to selection-restoration order.

Packaged custom Dock icons, Linux/Windows Electron behavior, and remote-device HTTP clipboard permissions have not been manually exercised on those environments. No performance thresholds were changed; Phase 2 measurements remain separate.

## PR #41 review follow-up

- File drafts retain the content hash they were based on. A refetch with changed content preserves the draft, shows a conflict, and blocks manual save and autosave until an explicit reload. Browser coverage includes a second refetch while the conflict is visible and a save after reloading.
- Sidebar, project removal and archive settings delete all selected threads before considering worktree cleanup. Only accepted deletions affect navigation and survivor checks; failures remain selected and show their errors. Cleanup rechecks surviving threads after confirmation and uses non-force removal. Tests cover either deletion order and a thread linking to the worktree during confirmation.
- Blocking-question dismissal carries typed answers into the persisted composer draft. Full-app browser tests cover both option selection and turn-end dismissal. The unused message-mode condition was removed; async questions remain Phase 8 work.
- Saving a preview snapshot is advertised as neither read-only nor idempotent. A tools/list regression checks both annotations. PNG bytes are encoded once and reused.
- Locale lookup is cached. Preview focus closes menus through their explicit close API instead of broadcasting a synthetic pointer event to dialogs and other surfaces. Clipboard fallback preserves the API error as a cause and suppresses only its synchronous focus round trip, avoiding incidental blur commits.

Review validation: 441 browser tests pass across 47 files, including the actual ChatView wiring; four batch-deletion tests and five preview MCP tests pass. The macOS desktop smoke test passes. `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test:full` pass, including 2,586 server unit tests, 16 integration tests and 131 exhaustive Git tests. All 110 desktop unit tests pass. Online ledger validation passes with unchanged coverage and disposition totals. Existing optional live tests remain skipped.
