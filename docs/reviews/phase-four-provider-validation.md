# Phase 4 provider features

This change implements the approved Phase 4 provider work against the pinned upstream
`t3code` interval ending at `f5ef0ddb90a8c36584e181b1913e7b8a5df30ffc`.

- Claude reports rejected usage windows and reset times, deduplicates warnings within a
  turn, clears recovered windows, and names expired login failures. Codex uses its main
  limit snapshot rather than Spark limits and recognizes typed usage-limit failures.
- Cursor, Grok and Antigravity retain ACP native command inventories, including commands
  arriving before session creation completes. OpenCode uses its SDK command inventory and
  acknowledges native commands on the matching user-message receipt instead of waiting
  for generation. ACP thought chunks use the existing reasoning display.
- Project and user skill roots include `.agents`, `.opencode` and `.codex`. Antigravity
  adds current and legacy Gemini roots, including flat Markdown skills. Project definitions
  win filesystem collisions. Provider inventories include Grok plugin skills; disabled
  skills remain hidden. Composer selections use provider syntax and include the explicit
  instruction-file path when a discovered project skill is absent from the native inventory.
- Antigravity adds the pinned, verified installer, isolated account flow, resume, live model
  inventory, questions, native permission choices, form elicitation and subagent activity.
  See [provider setup](../providers/antigravity.md) for defaults and limits.

Protocol version 6 adds the Antigravity provider variant and persisted skill source paths.
Old tabs use the existing exact-version reload gate. Approval warnings are optional when
reading older activities. Existing model catalogs, permissions, account homes, durable
queue and compaction are preserved.

The broad upstream Grok reliability commit also includes Usage dashboard/transcript work.
That portion remains tracked for Phase 11 rather than being marked implemented here.
The upstream automatic maintenance subsystem is not adopted: F5's update advisor proposes
commands and does not run package-manager updates. Existing providers retain their enabled
migration defaults; only the new Antigravity provider defaults off.

## Verification

The implementation has been exercised with synthetic ACP agents and temporary account
homes. Coverage includes rejected/recovered Claude limits, typed Codex limits, startup
command delivery, OpenCode command acceptance, skill collisions and malformed inventories,
permission warnings, native questions in full-access mode, disabled compaction, profile
isolation, owner cancellation, install interruption/hash mismatch and bounded stdout.

The official macOS arm64 archive was downloaded into a disposable profile, verified against
its pinned hash and byte sizes, and initialized over ACP. It reported release 1.1.1 with
resume and logout capabilities. No personal account was signed in. Authenticated native
turns and Linux/Windows native execution have not been exercised on this macOS host.

A full workspace suite and exhaustive real-Git matrix passed during implementation;
all 133 real-Git tests passed. The browser suite passed all 481 tests, including the
native-permission browser test. A desktop smoke instance passed after
repairing the worktree's missing Electron binary using the checksum-verified cached archive.
The standard Electron installer exited before extraction completed on this host's Node 26;
this was a local dependency setup problem, not an application-code change.

The existing profile-watch test was changed from a fixed 200 ms sleep to bounded polling
following a loaded-suite timeout; its assertion is unchanged. An earlier browser run timed
out in the existing GitHub account test; that suite passed on rerun and the subsequent full
browser run passed.

Final checks: `bun fmt`, `bun lint`, `bun typecheck`, `bun run test:full`,
`bun run --cwd apps/web test:browser`, `bun run test:desktop-smoke`, and
`F5_REQUIRE_UPSTREAM=1 bun run upstream-ports:check` passed. The ledger is updated
separately after the implementation commit exists, with one record retained for Phase 11.
