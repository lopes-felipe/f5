# Changelog

All notable changes to F5 are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) for the published CLI (`t3`) and the desktop app.

## [Unreleased]

### Added

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
- Thread activity tails are capped at the newest 500 rows, with explicit null-safe cursor pages for
  loading older work-log entries without materializing the full activity history on thread open.
- An Agents right-panel surface groups durable workflow and direct-subagent work, shows live counts,
  and links each entry back to its source timeline activity across threads and restarts.

### Changed

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
  Clients must be upgraded before using these actions; existing snapshots remain decodable because
  the new thread fields are optional.
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
