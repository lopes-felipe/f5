# Changelog

All notable changes to F5 are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) for the published CLI (`t3`) and the desktop app.

## [Unreleased]

### Added

- Claude in Chrome lifecycle behind a single certification record (`claude-chrome`, macOS arm64 first, gate closed until a live run is recorded): per-instance readiness with specific reasons, consent for foreign setup, `external-cli-conflict` when a terminal `claude --chrome` takes the connection back, desktop-owned stop that ends the CLI's process group even when the server is frozen, and setup history that can restore the original browser files after restarts and SDK upgrades. `bun run sdk:audit` fails when an advertised record no longer matches the pinned SDK.
- Codex Chrome control (`enableCodexChrome`, off by default, never settable from `f5.json`): ChatGPT for Chrome runs through an F5 MCP proxy that checks every call itself, takes the browser only for the duration of a call, and needs Full access and an isolated Codex home. The gate stays closed until the `codex-chrome` record is certified.
- Codex Computer Use (Sky) spike harness through the same proxy; there is no `codex-computer` record, so Codex keeps using F5's computer control. Claude's built-in computer use now explains that the CLI starts it only in interactive terminals.
- Two-phase integration certification: a live run on a clean commit stamps the record (`evidenceCommit`), and a release that embeds a certified record is published only by `bun run release:promote` after an operator acceptance run (`bun run integrations:accept`) of that draft's exact DMG. Codex records now certify a version floor, so newer ChatGPT builds stay open while every signature, origin, inventory and schema check still passes. The Codex Chrome harness also proves that pausing stops background work an earlier call started.

## [0.1.0] - 2026-10-18

### Installation

- Windows x64 is the first stable desktop platform: an unsigned per-user installer with in-app updates from the GitHub release feed. SmartScreen may warn, and Windows 11 Smart App Control blocks unsigned apps; see the install guide. A later signed release updates unsigned installations in place.
- The download page links the Windows installer, keeps the labelled macOS Apple Silicon preview, and shows "Not yet available" for macOS Intel and Linux instead of a misleading link.
- Releases follow a checked-in desktop profile (`windows` or `all`). Windows-only releases are refused once macOS or Linux updates have shipped. Every release verifies the `SHA256SUMS` contents and the packaged update feed, and must pass a Windows install, upgrade and uninstall rehearsal between two unpublished builds of the release commit.
- Fix a Windows update install that could leave F5 unresponsive with no windows: stopping the backend no longer blocks the main process.
- Release builds are titled "F5"; the "Alpha" label is gone, so the app is no longer confused with the legacy F5 (Alpha).
- The Windows CLI archive and `f5 install`/`f5 update` use the Windows `tar`, so installs work when Git Bash or MSYS GNU tar is first on PATH, and the runtime check exits instead of hanging.

- Production desktop updates now use only the public baked GitHub feed; ambient `GH_TOKEN` and `T3CODE_DESKTOP_UPDATE_GITHUB_TOKEN` private-feed overrides are no longer supported.

- F5 now uses its own app identity and imports existing F5 (Alpha) settings once. Screen Recording and Accessibility must be granted again.
- Preview-browser sign-ins may need to be redone because the Chromium cookie key is bound to the old app identity. Backend data under `~/.f5` is unchanged.

### Profiles

- Read Codex account usage through each configured provider instance's home and environment instead of the machine-wide legacy configuration.

- Preserve the real macOS home for managed Claude keychain access while retaining profile-specific Claude configuration and credential entry names.
- Add a Codex device-code sign-in alternative and prevent incomplete or expired login links from being offered by the account panel.

- Allow Codex 0.144.3 and newer in isolated profiles. Versions differing from the audited baseline show an informational notice without disabling sign-in or sessions; managed credential isolation remains required.

- Add separate profile state, provider homes, browser origins and desktop partitions with in-app account setup. Default data remains in place.
- Strip ambient provider credentials for non-default profiles; explicit instance API tokens remain supported.
- Non-default profiles use saved GitHub tokens and managed Git identity; Default retains host Git configuration, SSH, ambient tokens and existing gh logins.
- Preview discovery uses only URLs detected in owned output for all profiles; enter externally started servers manually.
- MCP CLI login times out after nine minutes to leave teardown time within the shared ten-minute OAuth lease.
- Fix Claude instance environments, Windows home overrides, instance model-catalog credentials, configured worktree roots, and explicit-state-dir backup settings/secrets.

### Server performance and storage

- Fix review findings in streaming retry recovery, legacy attachment backup coverage, settings credential redaction, scheduled-backup diagnostics and cleanup, skill watcher recovery, and workflow detail invalidation. Add an independent streaming-batching startup switch.
- Coalesce Codex streaming assistant and reasoning deltas with ordered, idempotent batches and full-text completion recovery.
- Export backups through an owned maintenance process while normal writes continue; protect snapshot attachments from cleanup. Add opt-in daily backups retaining seven successful archives, with credentials excluded. Preserve attachment ownership when restoring into a different state directory.
- Refresh only dirty projects’ skills, preserve unchanged watchers, and show scan diagnostics in project settings.
- Load workflow summaries at startup and fetch full run details when a workflow is opened. Upgrade the wire protocol to 22.

- Fix reliability review findings: persist delivery reservation release across rewind, preserve editor draft identity after saving, admit controls during resynchronization, retry overloaded reads safely, and start offline-mounted terminals once synchronized. Preserve normal umask permissions for new workspace exports.

### Reliability

- Keep stop, approvals, user-input answers and supported steering responsive while a provider prompt is pending, and prevent late results from reviving a stopped generation.
- Run durable deliveries independently across threads, scan a bounded rotating backlog, retain delivery reservations, and preserve unknown history as ambiguous recovery evidence.
- Save workspace files with explicit create or hash-match conditions, cross-profile connection-owned locks and atomic installation. Artifact exports never overwrite an existing file.
- Persist revisioned editor draft branches in IndexedDB with explicit recovery choices and concurrent-window discovery.
- Recover terminals with a read-only revisioned snapshot and bounded event replay, preserving clear and lifecycle ordering.
- Reserve separate RPC lanes for stop, answers and recovery, reject overload with retryable busy responses, and bound startup event buffering.
- Keep reading, copying and local drafting available during outages. Server changes resume only after synchronization; reconnect never sends a pending mutation automatically.
- Bump the wire protocol from 20 to 21 for conditional writes, terminal revisions and busy responses.

### Performance

- The sidebar, Home, command palette and inactive chat views no longer re-render on every streamed token of another thread. Timeline rows re-render only when their own content changes, and a row that fails to render shows "This entry could not be displayed" with "Copy error report" while the rest of the timeline keeps working.
- The React Compiler now optimizes the timeline rows, sidebar, Home, command palette results and chat header.
- Components re-render only when the settings they read change, not on every settings write.
- The file browser renders only the rows in view, so large folders scroll smoothly; the "Show more entries" button is gone and revealing a file scrolls straight to it.
- Message bodies of at most 10 inactive threads (32 MiB) stay in memory; older threads reload their latest messages when opened. Drafts, titles and status are always kept. Background prefetching pauses while the threads on screen alone exceed that budget.
- Large code blocks highlight in a background worker. Blocks over 200 KiB or 4,000 lines show as plain text with a "Highlight code" button, and unknown languages show as plain text.
- Open files and visible folders refresh when they change outside F5, including editors' atomic saves, renames and deletes. Unsaved edits get the existing conflict notice instead of being replaced; F5 falls back to polling when the file system cannot be watched. After an agent turn only that workspace's files and listings refresh.

### Added

- Error boundaries around each route and each right-panel tab: a failing page or tab shows "Try again" and "Copy error report" in place while the sidebar, composer and other tabs keep working.
- A "Window title" setting in Settings > General chooses whether thread and workflow titles show the project name (default) or the thread or workflow title, which can appear in screen shares and window switchers.
- CI boots the server under Bun (`bun run test:bun-server-boot`) so a Bun-incompatible import fails the build instead of `bun run dev`.

- New "F5 Graphite" default theme with Inter, a cobalt accent, derived faint/attention/chrome tokens, stricter contrast checks, a `text-2xs`/`text-ui` type scale, motion tokens, and a design-token test that rejects raw palette colours, arbitrary text sizes, faded text and pixel radii anywhere in the web app (`apps/web/scripts/codemod-ui-tokens.ts` rewrites most of them). Text inputs no longer default to monospace; path, URL, port and shortcut fields opt in. The default theme keeps its id, so everyone on it gets Graphite, and the interface font changes from DM Sans to Inter; the previous palette stays available as "F5 Black (classic)" in Appearance (its secondary text is slightly lighter to meet WCAG AA). DM Sans is no longer bundled, so an interface or chat font saved as "DM Sans" before this release resets to the default once. The `destructive-foreground` theme token now means red text on ordinary surfaces rather than text on a red fill; a custom theme override that is unreadable on its background (under 4.5:1) is ignored in favour of the generated colour.
- Independent thread summary settings, defaulting new and existing installations to
  Codex/OpenAI with GPT-5.6 Luna and low reasoning effort. Summary inputs (messages,
  activities, plans, tasks, and checkpoints) from **all providers** are sent to the
  selected summary account. Choose a different account/model in Settings > Providers >
  Thread summaries. If that instance is missing, disabled, or deleted, existing notes
  are retained until a working summary instance is selected; no provider fallback occurs.

- Claude Opus 5.5 support across Claude model pickers (requires Claude Code v2.1.280+), with native
  1M context and fast mode, and the bundled runtime upgraded to v2.1.280. Opus 5.5 is now the
  default Claude model and defaults to `medium` effort, matching Claude Code. Bare `opus` and
  `claude-opus` aliases now select 5.5; `opus-5` remains pinned to Opus 5. Older custom CLIs omit
  5.5 from pickers and fall back to the first supported built-in, which is Opus 5 on v2.1.220
  through v2.1.279. Isolated profiles now certify Agent SDK 0.3.280. Persisted bare aliases in
  threads or sub-agent overrides may fail at runtime; select a supported model or upgrade the
  executable to recover.

- Claude Fable 5.1 support across Claude model pickers (requires Claude Code v2.1.257+),
  with native 1M context and the bundled runtime upgraded to v2.1.261.
  Bare `fable` and `claude-fable` aliases now select 5.1; `fable-5` remains pinned to 5.
  Older custom CLIs omit 5.1 from pickers. Persisted bare aliases in threads or sub-agent
  overrides may fail at runtime; select a supported model or upgrade the executable to recover.
  Fable 5's default effort is now `high` (previously `max`); explicit effort is preserved.
  Auxiliary Claude generation now preserves `xhigh` and applies the `ultrathink` prompt prefix.
- GPT-6.1 Sol and GPT-6 Astra support across Codex model pickers; GPT-6.1 Sol is the Codex
  default and both require Codex CLI 0.153.0+. New `6.1` and `gpt-6.1` aliases select
  GPT-6.1 Sol. Astra caps reasoning at Max; GPT-6.1 Sol keeps every effort through Ultra.
  Older CLIs may reject these models when opening a thread or sending a turn; select another model
  or upgrade Codex to recover.
- Four runtime safety modes: Supervised, Auto-accept edits, Codex Auto review, and Full access,
  with provider-specific capability gating.
- Durable per-thread next-turn queues with pause/resume, editing, reordering, run-now,
  duplication, retry, bulk clear/undo, queue badges, keyboard shortcuts, and queue visibility
  outside the active thread.
- Crash-replayed provider turn delivery with Recheck/Retry/Discard recovery, durable
  turn-processing quiescence, and explicit attachment ownership/cleanup records.
- Claude Opus 5 support as the new Claude default (custom Claude binaries require Claude Code
  v2.1.220+).
- Claude Fable 5 support (requires Claude Code v2.1.170+).
- Add Claude Opus 4.8 to the Claude provider model list.
- `NOTICE.md`, `ARCHITECTURE.md` (root stub), `SECURITY.md`, `CODE_OF_CONDUCT.md`, and `THIRD_PARTY_LICENSES.md` at the repository root.
- `docs/provider-prerequisites.md` covering both Codex and Claude Code install/auth.
- Documentation index at `docs/README.md`.
- `bun run screenshots:capture` regenerates the README and marketing screenshots from seeded demo data in an isolated temp root.
- Drift test (`scripts/env-docs-drift.test.ts`) checking that every `F5_*`/`T3CODE_*` variable in `turbo.json` `globalEnv` is documented in `docs/environment.md`.
- Server-authoritative thread pins and snoozes with global pin ordering, durable expiry, wake
  predicates, and one-time migration of legacy browser-local pins.
- Race-safe thread title regeneration using current conversation context, correlated requests,
  title provenance/revisions, and stale-result protection for manual renames and newer requests.
- Per-project workspace defaults and manual icons, plus safe checked-in `f5.json` configuration for
  non-executable workspace and icon fields (`t3.json` is accepted read-only for interoperability).
- Thread activity tail reads return at most the newest 500 rows, with explicit null-safe cursor
  pages for loading older durable work-log entries without materializing the full activity history
  on thread open.
- Thread history now loads one bounded page when the virtualized timeline reaches its top, keeps
  the visible viewport anchored across prepends, and can hydrate unloaded message deep links with
  server-resolved anchor and forward cursors across adjacent timeline streams.
- An Agents right-panel surface groups durable workflow and direct-subagent work, shows live counts,
  and links each entry back to its source timeline activity across threads and restarts.
- A Usage dashboard reports provider-supplied tokens and API-equivalent cost over 24-hour, 7-day,
  30-day, and 90-day ranges. New turn facts are captured at provider-event ingestion, historical
  event-log costs remain visible with explicit partial-coverage diagnostics, and missing prices are
  shown as unreported rather than estimated or treated as zero.
- Pull-request identity, authentication state, capabilities, and provider-native metadata now pass
  through a provider-neutral source-control seam. GitHub behavior is preserved, unsupported
  providers fail closed, and repository discovery considers every configured Git remote.
- GitHub and GitHub Enterprise pull requests now expose in-app Summary, Timeline, and Files tabs,
  including cached failure-tolerant reads, comment edits, reactions, reviewer changes, and branch
  updates gated by provider capabilities and account permissions.
- A dedicated Appearance category now provides validated interface, chat, code, and terminal font
  controls. Changes apply live across app chrome, messages, the composer, diffs, previews, and
  xterm terminals, which refit without restarting their sessions.
- A local theme library now separates light/dark/system mode from color palettes, applies themes
  before first paint, generates accessible OKLCH palettes, and supports bounded custom-theme
  editing, export, and file-drop import from F5 JSON, VS Code JSON/JSONC, or VSIX files.
- Desktop previews now retain a bounded recent-site history, show validated same-origin page
  favicons and titles in panel tabs, persist color-scheme and viewport/aspect preferences, and list
  only local development servers that answer a bounded readiness probe.
- Session failures now carry stable server-generated identities and occurrence times, so dismissing
  an error survives reconnects while a later failure with identical text remains visible.

### Fixed

- `scripts/run-demo.ts` no longer deletes a caller-chosen directory or inherits provider credentials.
- Telemetry is off unless `T3CODE_POSTHOG_KEY` is set. Builds without a key no longer create an anonymous id, open an HTTP client or send heartbeats.
- Streaming assistant replies no longer re-read every message in the thread for each delta; the projection reads only the affected row, so long threads stay responsive while a reply streams. A message row owned by another thread is never overwritten.
- Code blocks no longer crash with a React hook-order error when a highlighted block is shown again from cache, and two different code blocks can no longer share a cached highlight.
- The marketing site's download buttons and repository links point at F5 releases (`lopes-felipe/f5`, overridable with `F5_RELEASE_REPOSITORY` at build time) instead of upstream T3 Code; corrupt or failed release lookups are handled instead of showing broken links.
- The once-a-second elapsed-time clock no longer re-renders the whole chat timeline; only the live "working" label and running command cards update, and a command left running on an idle thread stops counting.
- Code-review and investigation workflow stages complete only with the turn they dispatched. A stale or user-started turn on a reused stage thread can no longer stand in for the stage's own output, and a stage whose provider confirms delivery only after the turn finishes (or across a restart) still completes. Stages started before this release keep the previous rule. Planning workflows are not yet covered.
- The desktop app's backend crash budget resets after a minute of healthy running, so isolated crashes days apart no longer exhaust restarts; restarts back off exponentially up to 10 seconds.
- Typing in the composer no longer serializes every thread's draft on each keystroke; drafts are serialized once when the debounced write runs.
- Native window and browser tab titles follow the current page (Usage, Pull Requests, Settings, or the project or thread of the open thread or workflow), with the profile name appended outside the default profile, instead of a fixed app name.
- Sending a message while scrolled up follows the new turn to the bottom when it starts a new turn; steering a running turn leaves your scroll position alone.
- The workflow run inspector loads only when expanded, refreshes when the run changes, and shows a retryable error instead of an empty panel.
- Screen readers announce each approval or question that needs you (including several in one turn) and announce a turn's outcome ("Response ready", "Response failed" or "Response stopped") once, instead of a generic or repeated status.
- `bun run dev` starts the server again; Bun-incompatible `node:sqlite` imports are loaded lazily per runtime.

- Claude turn costs are no longer over-counted. The Agent SDK reports a running total per session,
  which F5 was adding to workflow budgets and usage reporting on every turn, so a long thread could
  hit its cost limit far below actual spend. Turns now report deltas. Resumes remain compatible
  with older custom CLIs without requiring the experimental usage RPC. Resume cursors now retain
  the last observed total so model, effort, and idle-session restarts preserve cost accounting.
  Older cursors without a baseline and native-log repairs still leave costs unreported. Zeroed
  crash placeholders remain unpriced. Reset inference and missing baselines can under-count spend.

- Clarifying questions asked during a workflow's merge or revision stage no longer fail the turn.
  Those stages ran as `unattended-readonly`, so a question was treated as a profile violation that
  interrupted the turn and discarded its work, while the model was simultaneously being told by
  plan-mode instructions to ask questions. `merge` and `revision` are now `attended-readonly`: the
  question is surfaced and the workflow waits for an answer. Fan-out reviewer stages stay
  unattended, but a question there is now recoverable — the request is auto-declined with guidance
  to pick and document a conservative default instead of killing the turn — and the workflow
  host contract is placed after the collaboration-mode block so it can override plan mode's
  instruction to ask questions.

### Changed

- The rest of the web app now uses the same type scale and semantic colours: diff, file, plan and agent panels, the command transcript (its shell syntax colours follow the theme), pending questions, onboarding checks, Pull Requests, Usage and profiles. Every control without its own focus style shows a theme-coloured keyboard focus ring, and custom provider instances are marked with an accent dot instead of tiny initials.
- Settings navigation is grouped (App, Interface, Agents, Data, About) with an icon per page, and every page uses the same cards with divided rows instead of boxed rows. A keyboard shortcuts reference opens with `Mod+/` (the new `help.shortcuts` command), from a button next to Settings in the sidebar footer, or from the command palette; it lists your current bindings by area and can be filtered. The palette adds "Go to Home", and "New thread in ..." targets your most recent project when no thread is open. Pull Requests and Usage show their name in the title bar (the Pull Requests view toggle and refresh actions now sit there), the no-thread screen uses the standard empty state, and the startup skeletons match the new thread and workflow layouts.
- The New Workflow dialog is wider with two columns: workflow types as cards with an icon and a one-line description next to the prompt, and each model on one compact row beside it. Own-model review, plans directory, compare branch and the cost limit sit in a collapsed Options section that summarises the current choices. The implement dialog uses the same model row and Options.
- Workflow pages share one layout: a title bar (project, workflow type, status, close), a title with status, cost, run time and project, then the steps as a board of phase columns on wide screens (a list below `lg`), and below them failed steps, the produced plan, document, review or analysis, the collapsible requirement and the run inspector. Each step shows its role, status and model (the configured model until its thread exists) and, while running, what its thread is doing. "Back to chat" is replaced by the close button.
- Home is a dashboard: a greeting and a quick-start card (project picker, "New workflow", "Add project", and Start, which opens a new thread with your text in its composer and focused, never sent), then Pinned, a "Needs you" grid of cards with one action each (Review plan, Answer, Review approval; the first eight show, with "Show more" for the rest, and workflow steps waiting on an approval, an answer or a paused queue are included), Working and Recent rows without idle chips. The stat strip and the old header are gone, and the onboarding panel and startup skeleton use the same flat styling.
- The composer floats as a dock over the end of the conversation (the last message always scrolls clear of it), with a tray on its top edge for thread notices (at most two, then "N more notices"; the thread error, pending-send recovery and provider health banners move here from under the header), worktree setup, the turn queue, agent questions and rewind drafts. Its footer has an Add menu, quiet model, traits and access chips, an Agent/Plan switch, a "Plan panel" toggle, and a context-window ring that replaces the header token badges; provider runtime details are a one-line strip under the header and the branch line is a single quiet row.
- The chat composer takes grouped props (pending interaction, model, mode, send and attachment controls) and its footer controls and primary action live in their own `composer/` modules. No visual or behavioural change.
- Conversation reading: a Conversation width setting (narrow, comfortable, wide); quieter user bubbles and assistant actions in a footer row; file references share one chip style; work logs from finished turns collapse to a one-line summary when the next turn starts (Collapse finished work logs, on by default and off in the Detailed profile); the working row shows the current activity; a richer empty thread state; and "Jump to latest" marks new content while scrolled away.
- Thread header is a breadcrumb (project, workflow, title, status) with a Files/Diff/Agents/Terminal toggle group that folds into a Panels menu when narrow; the inline right panel is its own canvas with quieter tabs; multiple terminals use a top tab strip instead of a side list, and the drawer gains a Hide terminal action.
- New canvas shell: the content area is a raised rounded canvas inside the sidebar chrome, every route shares one title bar (Electron drag region, sidebar toggle when collapsed), and the sidebar is redesigned with New thread/New workflow actions, a "Needs you" section, quieter project and thread rows, phase-labelled workflow threads with model chips, and in-row archive actions.
- The sidebar is split into `components/sidebar/` modules (brand header, nav, add-project form, project and workflow items, one shared thread row, and thread-action hooks) with a shared per-thread status map. No visual or behavioural change.
- Implementation-planning workflows now require an explicit plan submission, including v1 runs
  already in progress. Unwrapped assistant text and changed Markdown files are no longer captured
  as plans. Missing submissions receive one format-repair attempt before the stage reports an error.
  Previously saved plans and document workflows are unchanged.

- PR Hub keys are now provider-qualified (for example, `github:github.com/owner/repo#123`). Existing
  GitHub rows are migrated automatically, and legacy unqualified command keys remain accepted.

- **Breaking:** `RuntimeMode` now includes `auto-accept-edits` and `auto`. Older clients reject
  threads, queued turns, or events carrying either literal cleanly and must be upgraded before
  using those modes.
- **Breaking:** the old `nextTurnQueue.enqueue` and `nextTurnQueue.resume` WebSocket methods were
  replaced by server-owned `nextTurnQueue.submit`, `nextTurnQueue.setPaused`, and the expanded
  queue mutation API. Established-thread sends now always pass through durable admission.
- **Breaking:** removed the unused `orchestration.replayEvents` WebSocket RPC. Clients must use
  bounded startup snapshots, thread tails, and history-page APIs instead of requesting the full
  event log in one response.
- **Breaking:** pin and snooze lifecycle commands add new orchestration domain-event variants.
  Clients must be upgraded before using these actions; existing snapshots remain decodable through
  optional/defaulted thread fields.
- **Breaking:** title regeneration adds new orchestration domain-event variants. Existing thread
  snapshots remain decodable through optional/defaulted title-state fields.
- Correct Claude Fast Mode availability: enabled for Opus 5 and Opus 4.8, and disabled for Opus
  4.7, 4.6, and 4.5.
- **Breaking:** the web server now binds to `127.0.0.1` by default. Remote deployments must set an
  explicit non-loopback `--host`, use an authentication token of at least 24 bytes, and provide
  encrypted transport through a private network or HTTPS/WSS reverse proxy.
- README rewritten for the current feature set (seven providers, four workflow types, thread workspace, PR hub, usage) with regenerated screenshots, plus new workflow, thread and agent-tool guides and a docs index.
- `CONTRIBUTING.md` restructured so "how to run / test / ship" appears before the triage policy.
- `AGENTS.md` adds a Repository map section and now mentions both Codex and Claude Code.
- `docs/release.md` updated to reference the `lopes-felipe/f5` repo and document the legacy `t3`/`T3CODE_*` identifier policy.
- Stale docs under `docs/` (formerly `.docs/`) rewritten to name F5 and both providers (Codex + Claude Code).

### Moved

- Internal `.docs/` directory promoted to `docs/` so GitHub renders it in the repository sidebar.

---

The first public release will populate this file with a `vX.Y.Z — YYYY-MM-DD` section and begin tagging entries accordingly.
