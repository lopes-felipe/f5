# Cursor live gates

The evidence record for F5's Cursor integration. Each row is one live check.
A row gates exactly one feature, in both UI exposure and server admission,
through the checked-in gate table in `packages/shared/src/cursorHarness.ts`
(`CURSOR_ACP_GATES` and `CURSOR_SDK_GATES`). A failed or pending row disables
only its own feature; it never changes the architecture.

Flip a gate only in the same change that fills its row here with the date,
versions and the probe output summary. Paid accounts, raw transcripts and
credentials never go into this file or the default test suite.

## Pins

| Item                           | Value                                         | Recorded   |
| ------------------------------ | --------------------------------------------- | ---------- |
| Cursor CLI used for ACP shapes | `2026.07.09-a3815c0` (local)                  | 2026-11-23 |
| `@cursor/sdk`                  | `1.4.2`, unpatched (not yet a dependency)     | —          |
| Upstream T3 Code port commit   | pending: fetch upstream and record one commit | —          |

## On-disk session layout (observed 2026-11-23)

Observed read-only on a development machine with 273,156 entries in
`~/.cursor/acp-sessions`:

- every `session/new` leaves `~/.cursor/acp-sessions/<sessionId>/meta.json`
  holding `{ "schemaVersion": 1, "cwd": "<workspace>" }`;
- a session that ran a prompt also leaves
  `~/.cursor/chats/<md5(cwd)>/<sessionId>/store.db`
  (verified: `md5("/Users/…/dev/wolt/f5")` matched an existing chats key);
- almost all entries are metadata-only.

F5 deletes only those two paths, for sessions it created, after the agent
exits (`apps/server/src/provider/cursor/CursorNativeSessions.ts`). Existing
leaked sessions are reported by `bun apps/server/scripts/report-cursor-acp-sessions.ts`
and never deleted automatically.

## ACP rows

| Row                                                                                                                                                                    | Gate                                                                                                                                                                      | Status                                                                                                                                                | Evidence                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `cursor/ask_question` outcome shape (`answered` / `skipped` / `cancelled`, answers by option id)                                                                       | shipped (documented shape)                                                                                                                                                | docs only                                                                                                                                             | cursor.com/docs/cli/acp, 2026-11-23 |
| CLI behavior after each `cursor/create_plan` outcome; which one ends the turn without executing                                                                        | `CURSOR_ACP_GATES.planReplyOutcome`                                                                                                                                       | pending                                                                                                                                               | —                                   |
| Question fallback: option kinds and `_q<n>` tool call ids (0- or 1-based); one `allow_once` per choice or one per question; zero-option questions                      | fallback guard (shipped defensively): a settled answer replays only for a single-question group facing one `allow_once` option, otherwise the fallback is shown as a card | pending                                                                                                                                               | —                                   |
| `cursor/update_todos`, `cursor/task`, `cursor/generate_image` sent as requests; accepted replies                                                                       | handlers (shipped for both forms)                                                                                                                                         | pending                                                                                                                                               | —                                   |
| `cursor/list_available_models` before any `session/new`                                                                                                                | `CURSOR_ACP_GATES.catalogWithoutSession`                                                                                                                                  | observed: answers after `initialize` alone (32 models, 4 to 9 s); no session files; signed out it returns an auth-required error and opens no browser | CLI 2026.11.22-e9042b2, 2026-11-24  |
| `authenticate` with `NO_OPEN_BROWSER=1` while signed out                                                                                                               | not needed: the catalog refresh never authenticates                                                                                                                       | not needed                                                                                                                                            | —                                   |
| `--auto-review` minimum CLI version; lab-channel restriction                                                                                                           | `CURSOR_ACP_GATES.autoReviewMinimumVersion`                                                                                                                               | pending (flag present in `agent --help` on 2026.07.09; behavior not certified)                                                                        | 2026-11-23                          |
| Ask mode holds a read-only workflow turn to read-only tools, including Cursor-native tools and ambient MCP that never call back, on fresh, resumed and scheduled turns | `enforcesReadOnlyWorkflow` (ACP: true, the admission F5 already had before this change)                                                                                   | pending: admission is unchanged, not certified                                                                                                        | —                                   |
| Every file a session leaves; `chats/<hash>` derivation                                                                                                                 | cleanup paths                                                                                                                                                             | observed (above)                                                                                                                                      | 2026-11-23                          |
| `chats/<hash>` input for a symlinked workspace (resolved or real path)                                                                                                 | cleanup paths (both keys are tried)                                                                                                                                       | pending                                                                                                                                               | —                                   |
| Which config dir and `AGENT_CLI_CREDENTIAL_STORE` values share one sign-in; whether a keychain store is shared across HOMEs                                            | account peers (keyed by real config dir + store selection)                                                                                                                | pending                                                                                                                                               | —                                   |
| `session/list` timing on a store with more than 100,000 sessions; `session/load` replays without running tools                                                         | track T3 (import)                                                                                                                                                         | pending                                                                                                                                               | —                                   |
| `agent status --format json`                                                                                                                                           | account strategy                                                                                                                                                          | observed: `{ status: "authenticated", isAuthenticated, hasAccessToken, userInfo: { email, … } }`                                                      | 2026-11-23                          |
| Output shapes of `agent login`, `update`, `mcp list`                                                                                                                   | account strategy                                                                                                                                                          | pending                                                                                                                                               | —                                   |

## SDK rows (`@cursor/sdk` 1.4.2, stock)

All pending. `CURSOR_SDK_GATES` is empty, so the SDK harness is reported
unavailable on every host and new SDK instances are refused at save time.

| Row                                                                                                | Gate feature         |
| -------------------------------------------------------------------------------------------------- | -------------------- |
| Redistribution permission for the unmodified SDK and helpers; Statsig telemetry review and opt-out | `distribution`       |
| Worker self-check from desktop artifacts, CLI archive and standalone build; size baselines         | `runtime`            |
| Simple, multi-turn, interrupt scenarios; create/resume/readback across workers                     | `runtime`            |
| Local idempotency; finding an accepted run after process death                                     | `runtime`            |
| Remote-browser sign-in, `/v1/me`, `/v1/models` shapes; ACP vs SDK model id diff                    | `runtime`            |
| Whether the agent's shell can read the API key                                                     | `runtime`            |
| Store location under an F5 `stateRoot`                                                             | `runtime`            |
| Plan mode blocks shell, writes, Task children, hooks and ambient MCP, including after resume       | `planMode`           |
| Steering acknowledgements including SDK-owned `queued`                                             | `steering`           |
| `summarize()` behavior                                                                             | `compaction`         |
| Rewind; repeating a rewind is a no-op                                                              | `rewind`             |
| Live subagent streams                                                                              | `subagentInspection` |
| Sandboxed run blocks; Auto-review denial behavior                                                  | `autoMode`           |
| Isolated F5 profiles                                                                               | `isolatedProfiles`   |

## Upstream patch row

Upstream's `patches/@cursor__sdk@1.4.2.patch` rewrites 16.7 MB of `dist`
bundles. It is not taken. Each behavior change still needs a keep, skip or
transform decision before track T4.

## Recorded deviations

- Native session ownership lives in the Cursor resume cursor (`createdByF5`),
  not in a binding-level `nativeOwnership` field or an instance-level
  `nativeProvenance`. R2 must move it to the binding before the SDK harness
  adds a second ownership source.
- A generated image is shown as its own assistant message, not attached to
  the tool item that produced it.
- The catalog refresh sends only `initialize` and `cursor/list_available_models`,
  in the background after a status check, at most hourly per CLI version and
  account. Auto's `optimize_for` option has no F5 control, so Auto runs with
  Cursor's default.

## Upgrade rule

Every SDK bump records the SDK version, package integrity, helper version,
host runtime and each certified feature, and reruns every SDK row.

## Read-only sandbox gates (C1-C4)

These gates decide whether Cursor read-only workflow stages can run in Cursor's
native sandbox (`agent --sandbox enabled acp` with a `workspace_readonly`
`sandbox.json`) rather than F5's command allowlist. Until they all pass on a
target, `CURSOR_READ_ONLY_SANDBOX_CERTIFIED_RUNTIMES` in
`packages/shared/src/readOnlyEnforcement.ts` has no row for it and Cursor stays
policy-enforced.

Run `node apps/server/integration/cursorSandboxGates.mjs` from a normal
Terminal: macOS refuses to start the sandbox inside an agent's sandboxed shell.
It spends three prompts and works in a fresh temp folder with its own HOME.
`--handshake-only` stops before the prompts. It checks that a sandboxed ACP
session starts, signs in and enters plan mode, and spends nothing.

The copied `cli-config.json` turns on Cursor's own "Run in Sandbox" preset
(`sandbox: { mode: "enabled", networkAccess: "user_config_only" }`,
`approvalMode: "allowlist"`) with an empty allowlist. C2 runs in plan mode. C3
and C4 run in the default mode, because in plan mode a compliant model declines
the writes itself and the write checks prove nothing. A write the model never
attempted is reported as inconclusive, not as blocked.

| Gate | Question                                                                                                                                                            | Result                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| C1   | Does Cursor stay signed in under a separate HOME?                                                                                                                   | Pass on darwin-arm64, CLI 2026.11.22-e9042b2 (2026-11-25), only with `Library/Keychains` linked |
| C2   | With `--sandbox enabled` and plan mode, which commands send `session/request_permission`, and does a request tell sandboxed runs from out-of-sandbox ones?          | Pending                                                                                         |
| C3   | Under `workspace_readonly` with network denied: do workspace, `.git` and outside writes fail, `curl` fail, `/tmp` writes succeed and Cursor's own fetch still work? | Pending                                                                                         |
| C4   | Does C3 still hold in a workspace whose own `.cursor/sandbox.json` asks for no sandbox and full network?                                                            | Pending                                                                                         |

- **C1:** the CLI keeps its sign-in in the login keychain through
  `/usr/bin/security`, which looks under `$HOME/Library/Keychains`. An empty
  separate HOME reports `isAuthenticated: false`. Linking only that folder into
  the read-only HOME restores the account without copying a token. Sessions also
  start, authenticate and enter plan mode with `--sandbox enabled` under that
  HOME (`--handshake-only`, same date). Linux keeps credentials elsewhere and
  needs its own C1 run.
- **First run (2026-11-25), inconclusive:** both C3 and C4 ran in plan mode.
  The model ran only `ls`, `curl` and the fetch, and declined every write
  ("Plan mode is currently active"). Each of those three asked F5 for
  permission with the text "Shell allowlist is empty" and no `rawInput`.
  `curl` returned 200. So the session was in allowlist mode with no sandbox:
  `--sandbox enabled` alone didn't turn on the sandbox while the copied
  config had no `sandbox` key. The script now sets the preset and runs the
  write gates outside plan mode.
- **C4 exists because** the CLI folds the workspace's own `.cursor/sandbox.json`
  into the per-user policy. A repository under review must not be able to
  loosen a read-only stage's sandbox.
- **The per-user policy path** is `homedir()/.cursor/sandbox.json`.
  `CURSOR_CONFIG_DIR` doesn't move it, so a separate HOME is needed.
