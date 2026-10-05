# Changelog

## Profiles

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

All notable changes to F5 are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) for the published CLI (`t3`) and the desktop app.

## [Unreleased]

### Added

- New "F5 Graphite" default theme with Inter, a cobalt accent, derived faint/attention/chrome tokens, stricter contrast checks, a `text-2xs`/`text-ui` type scale, motion tokens, and a design-token test that rejects raw palette colours, arbitrary text sizes, faded text and pixel radii anywhere in the web app (`apps/web/scripts/codemod-ui-tokens.ts` rewrites most of them). Text inputs no longer default to monospace; path, URL, port and shortcut fields opt in. The default theme keeps its id, so everyone on it gets Graphite, and the interface font changes from DM Sans to Inter; the previous palette stays available as "F5 Black (classic)" in Appearance (its secondary text is slightly lighter to meet WCAG AA).
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
- Drift test comparing the README env-var table against `turbo.json` `globalEnv`.
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
- Home is a dashboard: a greeting and a quick-start card (project picker, "New workflow", "Add project", and Start, which opens a new thread with your text in its composer and focused, never sent), then Pinned, a "Needs you" grid of cards with one action each (Review plan, Answer, Review approval), Working and Recent rows without idle chips. The stat strip and the old header are gone, and the onboarding panel and startup skeleton use the same flat styling.
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
- README rewritten with user-first framing (download links, explicit provider auth commands, install/run matrix).
- `CONTRIBUTING.md` restructured so "how to run / test / ship" appears before the triage policy.
- `AGENTS.md` adds a Repository map section and now mentions both Codex and Claude Code.
- `docs/release.md` updated to reference the `lopes-felipe/f5` repo and document the legacy `t3`/`T3CODE_*` identifier policy.
- Stale docs under `docs/` (formerly `.docs/`) rewritten to name F5 and both providers (Codex + Claude Code).

### Moved

- Internal `.docs/` directory promoted to `docs/` so GitHub renders it in the repository sidebar.

---

The first public release will populate this file with a `vX.Y.Z — YYYY-MM-DD` section and begin tagging entries accordingly.
