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
  win filesystem collisions; within a scope the selected provider’s native root wins. Provider inventories include Grok plugin skills; disabled
  skills remain hidden. Composer selections use provider syntax and include the explicit
  project-relative or home-relative instruction-file path for non-native skills. Native skills
  keep their own invocation without appending paths, including before the first session.
- Antigravity adds the pinned, verified installer, isolated account flow, resume, live model
  inventory, questions, native permission choices, form elicitation and subagent activity.
  See [provider setup](../providers/antigravity.md) for defaults and limits.

Protocol version 7 includes the Antigravity provider variant, portable skill paths,
provider-specific collision choices and optional form questions.
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

## PR review follow-up

Account admission now excludes sign-in/sign-out from session startup, turn dispatch and
one-off work. Active sessions are checked as a group before any idle runtime is stopped.
Installations retain the approved profile scope but no longer take the OAuth lease.

Codex retry warnings and untyped TPM errors retain their text. Confirmed limit hints append
rather than replace diagnostics. Claude interruptions and unrelated failures retain their
original outcome. Optional and free-text form fields survive projection decoding and can
be submitted without inventing answers or accepting hidden defaults. Currency-trigger
completion is restricted to Codex and matching skills, including the keyboard send path.
Grok global discovery runs outside project checkouts, while session discovery uses its cwd.

The Antigravity branch in legacy onboarding preflight was unreachable: that validator's
fixed provider list does not include Antigravity. The dead hard-coded account check was
removed. The active instance status path already takes the actual instance ID; a synthetic
custom-account test now verifies that it does not read the default account.

Python's `webbrowser` does split commands containing `%s`; the review's macOS parsing claim
was incorrect. The helper now uses a wrapper with a private Electron environment setting,
including a Windows command wrapper. The official macOS binary produced a validated Google
OAuth URL through the revised account flow, then was cancelled before consent. No personal
account login or authenticated turn was performed. Windows wrapper execution still needs
Windows validation. OpenCode's SDK was confirmed to connect lazily; its command-completion
fallback remains necessary if an early receipt is missed, and the comment now says so.

Follow-up validation passed formatting, lint, typechecking, the full workspace suite and
all 133 exhaustive real-Git tests. The browser suite passed all 483 tests with file
parallelism disabled. An earlier concurrent run failed existing focus/layout/settings
tests as well as the newly added currency test; that new test exposed a second keyboard
trigger path, which was fixed before the passing run. The account-job test separately
checks admission remains blocked until an auth job exits.

The revised desktop build passed its isolated Electron smoke test.
