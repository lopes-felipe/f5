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

## Read-only gates (C1-C6)

C1-C4 decide whether Cursor read-only workflow stages can run in Cursor's
native sandbox (`agent --sandbox enabled acp` with a `workspace_readonly`
`sandbox.json`) rather than F5's command allowlist. Until they all pass on a
target, `CURSOR_READ_ONLY_SANDBOX_CERTIFIED_RUNTIMES` in
`packages/shared/src/readOnlyEnforcement.ts` has no row for it and Cursor stays
policy-enforced. C5 and C6 check F5's read-only config override, which keeps
Cursor's own approval settings from letting commands past the policy (see
[Read-only config override](#read-only-config-override)).

Run `node apps/server/integration/cursorSandboxGates.mjs` from a normal
Terminal: macOS refuses to start the sandbox inside an agent's sandboxed shell.
Each gate spends one prompt, and C5 two with its control. `--gates C5,C6` runs
only the named gates. The script works in a fresh folder with its own HOME, under
`~/.f5-cursor-gates` unless `--root <dir>` names another parent. The folder is
deliberately not under a temp directory: Cursor's sandbox lets commands write to
temp directories, so fixtures there would make the write checks pass or fail for
the wrong reason. `--handshake-only` stops before the prompts. It checks that a
sandboxed ACP session starts, signs in and enters plan mode, and spends nothing.
The script exits non-zero unless every gate passed.

The copied `cli-config.json` turns on Cursor's own "Run in Sandbox" preset
(`sandbox: { mode: "enabled", networkAccess: "user_config_only" }`,
`approvalMode: "allowlist"`) with an empty allowlist. C2 runs in plan mode. C3
and C4 run in the default mode, because in plan mode a compliant model declines
the writes itself and the write checks prove nothing.

Each check is PASS, FAIL or INCONCLUSIVE, matched to the tool call by its
command (title and raw input), never by assistant text:

- **A write counts as blocked** only when its call was seen, nothing changed and
  the output shows a sandbox denial (`Operation not permitted`, `EPERM`,
  `Read-only file system`). A step the model skipped, or one that failed for
  another reason, is inconclusive.
- **`.git` is checked twice:** with a direct `touch .git/gate-marker`, and with
  `git commit` in a fixture whose local config sets an identity, so a commit can
  only fail because of the sandbox.
- **Temp writes are the positive control:** the run writes to both `/tmp` and
  `$TMPDIR`, records which landed, and needs at least one. Otherwise nothing
  shows the commands ran at all.
- **`curl`** is scored per call. Any HTTP status fails. A transport error (`000`,
  a curl error) passes only when the script's own unsandboxed request to the same
  URL got an HTTP status, so an offline host stays inconclusive.
- **Cursor's own fetch** must complete for C3 and C4 to pass.
- **`npm --version`** (C2, C5, C6) counts as "asked F5" only when a permission
  request names that call's `toolCallId`, and as "ran without asking" only when
  the call completed and printed a version.
- **Fixture setup** runs Git without the caller's `GIT_*` variables, global or
  system config, hooks or signing, and stops at the first failure.
- **Permission requests** are answered "allow once" only for the gate's own
  steps: a shell call whose command is exactly one of the prompt's backticked
  commands, or the fetch step. Anything else is refused ("reject once"), so a
  model that strays can't touch files or credentials outside the fixtures. A
  request is cancelled when it offers neither option. The report keeps each
  request in full, with its options and the answer; a fixture step reported as
  "refused (not a fixture step)" means Cursor described it differently, and the
  gate needs a look before its verdict counts.
- **Environment:** the script runs as the operator, with the operator's
  keychain (C1 links it). It is not isolated with disposable credentials; the
  allow-list above is what limits it.

| Gate | Question                                                                                                                                                          | Result                                                                                                        |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| C1   | Does Cursor stay signed in under a separate HOME?                                                                                                                 | Pass on darwin-arm64, CLI 2026.11.22-e9042b2 (2026-11-25), only with `Library/Keychains` linked               |
| C2   | With `--sandbox enabled` and plan mode, which commands send `session/request_permission`, and does a request tell sandboxed runs from out-of-sandbox ones?        | Every non-allowlisted command asks, including the `npm --version` trap; no sandbox (2026-11-25)               |
| C3   | Under `workspace_readonly` with network denied: do workspace, `.git` and outside writes fail, `curl` fail, temp writes succeed and Cursor's own fetch still work? | Fail: every write landed and `curl` returned 200 (2026-11-25)                                                 |
| C4   | Does C3 still hold in a workspace whose own `.cursor/sandbox.json` asks for no sandbox and full network?                                                          | Fail, same as C3 (2026-11-25)                                                                                 |
| C5   | Launched like a production read-only stage, does `npm --version` ask F5 when the user's config allows `Shell(npm)` but `CURSOR_CONFIG_DIR` points at F5's copy?   | Pass (2026-11-26): it asked F5; control C5a ran `npm` without asking. Rerun with the shipped sanitizer passed |
| C6   | Does Cursor honour `permissions.allow` from the repository's `.cursor/cli.json` over ACP?                                                                         | Yes (2026-11-26): `npm` ran without asking despite F5's override, so the repository guard is needed           |

**Outcome on CLI 2026.11.22-e9042b2: the ACP server has no sandbox.** The
second run (2026-11-25) had the sandbox preset in `cli-config.json`,
`workspace_readonly` in `sandbox.json` and `--sandbox enabled`. Every write still
landed, and every command asked with "Shell allowlist is empty". The bundle explains
why:

- `agent acp` builds its permissions from `PermissionsAdapter` and
  `PermissionsFileProvider` (`cursor-config/dist/permissions-adapter.js` and
  `permissions-file-provider.js`). Both return
  `userConfiguredPolicy: { type: "insecure_none" }` unconditionally.
- The provider that turns `sandbox.mode`, the `--sandbox` override and ask mode
  into `workspace_readonly` or `workspace_readwrite` is used only by the
  interactive and `-p` paths. The `acp` command never passes `--sandbox` on.
- So no setting enables the sandbox over ACP on this version, and
  `CURSOR_READ_ONLY_SANDBOX_CERTIFIED_RUNTIMES` stays empty. Cursor read-only
  stages remain policy-enforced. Re-run these gates when a Cursor release
  changes the ACP permissions provider.

**What the policy path relies on.** C2 shows that a command reaches F5 only
when Cursor's own approval doesn't already allow it:

- **Cursor runs these without asking F5:**
  - commands on the user's `permissions.allow` list (`Shell(…)`);
  - commands on `permissions.json` `terminalAllowlist` and team admin
    allowlists;
  - every command when `approvalMode` is `unrestricted`.
- **The gate runs reached F5 every time** only because they used an empty
  allowlist under a separate HOME.

### Read-only config override

Read-only Cursor stages launch with `CURSOR_CONFIG_DIR` set to
`<state dir>/provider-homes/cursor-readonly/<instance id>`
(`apps/server/src/provider/cursor/CursorReadOnlyConfig.ts`). The bundle for
2026.11.22-e9042b2 shows why that one variable is enough:

- **What follows `CURSOR_CONFIG_DIR`:** the CLI resolves its config dir as
  `CURSOR_CONFIG_DIR`, then `$XDG_CONFIG_HOME/cursor`, then `~/.cursor`
  (`cursor-config/dist/paths.js`). `cli-config.json` (`permissions.allow`,
  `approvalMode`), `permissions.json` (`terminalAllowlist`, `autoRun`),
  `acp-sessions` and `chats` live in it. User MCP servers (`~/.cursor/mcp.json`),
  rules and skills are read from the home folder and still load. F5's read-only
  ACP policy refuses every MCP call except its own read-only tools.
- **What F5 writes there:** a copy of the user's `cli-config.json` that keeps
  only display, model, account-display and privacy settings (`version`,
  `editor`, `display`, `notifications`, `hints`, `model`, `modelParameters`,
  `selectedModel`, `maxMode`, `hasChangedDefaultModel`, `exploreSubagentModel`,
  `privacyCache`, `authInfo`), with an empty allowlist (deny rules kept) and
  `approvalMode: "allowlist"`, rewritten at every start, and no
  `permissions.json`. Every other key, including `sandbox`,
  `autoAcceptWebSearch` and anything a later release adds, is dropped.
  `approvalMode` also accepts `unrestricted` and `auto-review`, and both let
  commands run without asking.
- **Sign-in doesn't move:** in the 2026.11.22 bundle, credentials are in the OS
  keychain (`AGENT_CLI_CREDENTIAL_STORE` unset) or `auth.json` under
  `~/.cursor` (macOS), `$XDG_CONFIG_HOME/cursor` or `~/.config/cursor` (Linux),
  or `%APPDATA%\Cursor` (Windows), never under `CURSOR_CONFIG_DIR`.
  `cursorCredentialStoreKey` keys on `~/.cursor` plus the store selection for
  that reason. Only darwin-arm64 with the keychain is verified live (C5
  signed in with `CURSOR_CONFIG_DIR` pointing at a folder holding only the
  sanitized `cli-config.json`). `AGENT_CLI_CREDENTIAL_STORE=file`, Linux and
  Windows are read from the source only and still need a live run.
- **Where read-only sessions are recorded:** `acp-sessions` and `chats` follow
  `CURSOR_CONFIG_DIR`, so read-only sessions live under
  `provider-homes/cursor-readonly/<instance id>`, not `~/.cursor`. Read-only
  sessions recorded under `~/.cursor` before this change can't be resumed. F5
  doesn't prune the folder, and backups that include `provider-homes` include
  it.
- **C5 was rerun the same day with the shipped sanitizer.** The first run's
  read-only copy also carried the sandbox preset the script adds for C2-C4,
  which production doesn't add. The script now builds C5's copy with
  `sanitizeCursorCliConfig` from the unmodified user config, and C6 always runs
  with C5 as its control. The rerun (CLI 2026.11.22-e9042b2, darwin-arm64)
  passed C1, C5a, C5 and C6 with the same outcomes. Its one permission request,
  for `npm --version`, carried no `rawInput` and was matched to the fixture step
  by its title.
- **Repository config:** the CLI also merges every `.cursor/cli.json` from the
  repository root down to the working directory into that config, using the
  full schema. C6 showed that ACP honours them: a repository allowlist ran `npm`
  without asking F5, even with F5's config override in place. F5 can't override
  those files, so a read-only stage is refused when, between the working
  directory and the filesystem root, a `.cursor/cli.json`:
  - sets anything but deny rules, an empty allowlist or `approvalMode:
"allowlist"` (unknown keys included);
  - isn't a regular file, can't be read, is over 256 KiB, or isn't strict JSON
    (the CLI might read JSON with comments that F5 can't).
- **Project hooks and MCP servers:** the CLI loads the workspace's
  `.cursor/hooks.json` (hooks run shell commands) and starts the project's
  `.cursor/mcp.json` servers once approved; approvals are kept per project in
  the CLI's data dir, so an earlier interactive approval carries over. Neither
  is a gate yet (C7/C8 would be), so a read-only stage is refused when either
  file, from the working directory up to the repository root, defines any hook
  or server, or can't be read as above. Your own `~/.cursor/hooks.json` and
  `~/.cursor/mcp.json` are left alone.
- **Known window:** the CLI reads the live workspace. F5 checks it at start and
  again before every turn, but a concurrent writer in the same worktree can add
  a project file between a check and the CLI reading it. No launch flag turns
  off project config discovery in 2026.11.22.
- **Team admin allowlists** come from Cursor's servers and stay out of F5's
  reach.

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
  write gates outside plan mode. The second run is the outcome above.
- **The 2026-11-25 results predate the stricter scoring** above. They are still
  fails: writes landed and `curl` returned 200, which no scoring change turns
  into a pass.
- **C4 exists because** the CLI folds the workspace's own `.cursor/sandbox.json`
  into the per-user policy. A repository under review must not be able to
  loosen a read-only stage's sandbox.
- **A C4 pass needs a positive control before certification.** With no
  per-user `sandbox.json`, run the same steps in two workspaces: one with the
  hostile policy and one without. The hostile policy must change the result (for
  example, `curl` returns 200 only there). A control that only shows `curl`
  succeeding in the hostile workspace proves nothing: a CLI that ignores
  workspace policy files and allows network by default gives the same result.
  On 2026.11.22 the sandbox never applied over ACP, so the control wasn't run.
- **Keychain exposure is a design risk for a production read-only HOME.** C1
  passes only with the whole login keychain folder linked, so sandboxed
  commands could run `security find-*-password`. Before any production use, add
  a gate showing `security` access is denied or scoped. The script removes its
  keychain link when it finishes, and keeps the run folder for `report.json`.
- **The per-user policy path** is `homedir()/.cursor/sandbox.json`.
  `CURSOR_CONFIG_DIR` doesn't move it, so a separate HOME is needed.

## Codex read-only escalation (G1-G6)

Run with `apps/server/integration/codexReadOnlyEscalationGate.mjs` on 2026-11-26:

- **Codex:** `codex-cli 0.170.0`, bundled with F5, on darwin-arm64.
- **Where:** F5's agent shell. It is itself inside a macOS sandbox, so Codex's sandbox fails to
  start there (`sandbox-exec: sandbox_apply: Operation not permitted`, exit 71), as it does in
  the desktop backend.
- **Requirements:** the organisation's managed requirements allow only `on-request` and `never`.
- **Mode:** the session ran as "ask on escalation": `approvalPolicy: "on-request"`, a read-only
  thread sandbox, and turn `sandboxPolicy: { type: "readOnly", networkAccess: false }`.

**Home:** the script's source home links a real sign-in and holds
`rules/default.rules = prefix_rule(pattern=["touch"], decision="allow")`. The first runs built
the read-only home with the script's own links (every entry except `rules`); the script now calls
`materializeCodexReadOnlyHome`. A rerun with it on 2026-11-26 passed G1-G3b and G6 again, with
G3 and G3b accepting only the exact commands. G4 was inconclusive in that rerun: no request and
no marker, but no command item for `touch` either, while the model reported the sandbox failure.

| Gate       | Result     | Observed                                                                                                                                                                                                                                                                                                        |
| ---------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1         | PASS       | `configRequirements/read` returns `allowedApprovalPolicies: ["on-request","never"]` and `allowedSandboxModes: ["workspace-write","read-only","danger-full-access"]`.                                                                                                                                            |
| G2         | PASS       | `thread/start` reports `approvalPolicy: "on-request"` and `sandbox: {type: "readOnly", networkAccess: false}`.                                                                                                                                                                                                  |
| G3         | PASS       | `git rev-parse HEAD` and `ls` each sent `item/commandExecution/requestApproval` by themselves once the sandbox failed, with `reason: "Allow running … outside the sandbox after the sandbox failed to start?"`, `command: "/bin/zsh -lc '…'"` and `kind: "command"`. Accepted, both returned their real output. |
| G3b        | PASS       | `stat notes.txt`, which isn't on Codex's own safe list, asked only because the turn carried F5's escalation hint. The model reran it with escalation (`reason: "Allow the read-only stat command for notes.txt?"`).                                                                                             |
| G3c        | PASS       | The escalation requests offer `accept`, `acceptWithExecpolicyAmendment` and `cancel`, but no `decline`. A plain `decline` is still taken: the item ends `declined`, nothing runs and the turn completes.                                                                                                        |
| G4         | PASS       | `touch marker` ran in the sandbox that can't start, failed with exit 71, and Codex didn't offer to escalate it. No marker.                                                                                                                                                                                      |
| G4 control | PASS       | The same turn with `rules` linked into the home: `touch marker` ran outside the sandbox with exit 0 and no approval request, and the marker appeared.                                                                                                                                                           |
| G4b        | PASS       | An `apply_patch` edit sent `item/fileChange/requestApproval`. Declined, the file is unchanged.                                                                                                                                                                                                                  |
| G4c        | PASS       | Web search returned a `webSearch` item (it runs server-side).                                                                                                                                                                                                                                                   |
| G5         | unit tests | F5's `.codex/rules` guard (`CodexReadOnlyHome.test.ts`, `CodexAdapter.test.ts`).                                                                                                                                                                                                                                |
| G6         | PASS       | After each session the read-only home's `auth.json` was still a link to the source. The sessions were short and likely never refreshed the token, so this doesn't show a refresh; Codex 0.170 resolves the link before replacing the file (`login/src/auth/storage.rs`), and F5 moves a newer real file back.   |

What the runs mean for F5:

- **Asking requires escalation:** Codex asks to rerun a command outside the broken sandbox by
  itself only for its own safe commands. Any other command fails closed unless the model
  escalates, so a policy-enforced Codex stage carries a one-line hint to do so.
- **F5 must refuse with `decline`** even when the request doesn't offer it. `cancel` would end the
  turn.
- **Allow rules bypass F5 entirely:** an `allow` rule runs its command outside the sandbox with
  no request at all (G4 control). That holds in every read-only mode, which is why read-only
  stages use a home without `rules` and refuse a repository's own `.codex/rules`.
- **Code mode doesn't skip approvals:** the model often runs commands through Codex's code-mode
  `exec` tool, which calls `exec_command` from JavaScript. Those nested commands asked and failed
  exactly like direct ones.
