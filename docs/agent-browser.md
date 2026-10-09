# Agent browser and computer use

How agents (Claude and Codex) see and drive web pages and, optionally, this computer, and
the safety rules each path follows. Settings live in **Settings → Browser and capture** and
per project in **Project settings → Conversation**. Every flag below is ANDed with
`enableAgentBrowserAccess`. A checked-in `f5.json` can never set `previewExternalHosts`,
`enableClaudeInChrome`, or `enableAgentComputerUse` (`USER_ONLY_PROJECT_SETTING_KEYS`).

## Rule: tools installed, execution gated

Preview tools are installed in every interactive desktop session. Each call resolves the
live policy (`resolveAgentBrowserPolicy`), so toggling a setting applies on the next tool
call without restarting the session. Policy lookups fail closed.

| Capability                | Claude                                 | Codex                                  |
| ------------------------- | -------------------------------------- | -------------------------------------- |
| F5 preview (`preview_*`)  | In-process SDK MCP server `f5_preview` | Loopback HTTP MCP `__f5_preview`       |
| External sites in preview | Allowlist (`previewExternalHosts`)     | Same allowlist                         |
| Claude in Chrome          | Blocked: `--no-chrome` always forced   | Not available                          |
| Computer use              | Blocked: never started, tools denied   | Not available (native backend blocked) |

## F5 preview

- **Provenance.** Claude tools are classified by exact `mcp__<server>__<tool>` name, and
  only after `mcpServerStatus()` reports the server as `source: "sdk"`. A project server
  with a look-alike name never inherits F5's exemptions.
- **Approvals.** Observation (`status`, `snapshot`, `screenshot`, `wait_for`) never prompts.
  Read-only workflow stages may observe but not write artifacts, so they get `snapshot`
  without `save: true` and no `screenshot`. Mutating tools follow the runtime mode; one
  "allow for session" grants the whole mutating family.
- **Screenshots.** `preview_screenshot` captures through a saving snapshot: the agent gets
  the image plus the saved artifact's id, without the page text and element lists.
- **Owner.** When no preview is open the server asks the most recently active window to
  host one (`ownerRequested`). The window pins a headless preview (at most 2 pinned of 4
  instances) and adds a Preview tab without stealing focus. Pins are released on user
  close, on `ownerReleased`, or after 10 minutes without agent activity.
- **Serialization and take-over.** Mutating actions run FIFO per thread (32 queued at most)
  and per tab in the desktop process. **Take over** pauses the thread: the running action
  stops at its next checkpoint (poll loops, before input, between 64-character typing
  chunks), queued actions fail with `PreviewAutomationControlInterruptedError`, and the
  agent is told to ask the user before continuing.
- **Bounds.** Snapshot images are at most 2560 px and 8 MiB (PNG, then JPEG, then smaller).
  Structured snapshot data is trimmed to 256 KiB, and the whole response must fit in 16 MiB.
  Anything larger fails with `PreviewAutomationResultTooLargeError`.
- **Diagnostics.** Snapshots include the last 50 console messages, navigation and failed
  loads, and the action timeline for the tab.
- **Screenshots in chat.** Before a tool lifecycle event is compacted into an activity,
  its inline images (PNG, JPEG, WebP, 8 MiB each) are moved into the attachment registry
  (owner kind `activity`, migration 109) and the result is scrubbed, so neither the
  activity nor its `mcpResult` text holds base64. Payloads keep only `mcpImages`
  references: one per tool item and 200 per thread, with `mcpImagesOmitted` counting the
  rest. Attachment ids derive from the thread, tool item, and content, so replayed or
  repeated events reuse one file. Bytes are staged, registered, then promoted, the same
  lifecycle chat uploads use, so startup recovery finishes or discards an interrupted
  write. Provider event logs replace inline base64 with a placeholder. Reverting a turn
  drops the ownership of its activities' screenshots, and storage cleanup reclaims the
  files.

## External sites allowlist

Grammar, one entry per line:

- `example.com`: that host over HTTPS.
- `*.example.com`: its HTTPS subdomains.
- `http://intranet.local`: one host over plain HTTP.
- `*`: any DNS host over HTTPS, after an explicit confirmation.

IP literals never match wildcards. Ports, paths, credentials, and other schemes are
rejected. Loopback is always allowed.

The desktop process enforces the list on `will-navigate`, `will-redirect`, and main-frame
`did-start-navigation`, and re-checks the current URL before and after every agent action.
A blocked navigation during an agent action fails it with
`PreviewAutomationNavigationBlockedError` (status reason `external-blocked`) instead of
opening the system browser. `preview_evaluate` is refused on any non-loopback page.
Sign-in popups stay with the user; the agent sees `popupOpen` in status and snapshots.

## Claude in Chrome: blocked on the native-host gate

`CLAUDE_IN_CHROME_CERTIFIED` (`claudeAgentBrowser.ts`) is `false`, so F5 always launches
Claude with `--no-chrome`, strips any user `--chrome` override, reports the capability as
"unavailable", and denies `mcp__claude-in-chrome__*` tools in the mandatory PreToolUse hook,
including in full-access mode. Settings can only switch the option off.

Launching with `--chrome` lets the CLI install or rewrite a Chrome native-messaging host
manifest, a persistent change to the user's browser setup. Certification must record, on a
real machine:

1. The manifests under `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
   (macOS) or the registry keys (Windows) before and after one `--chrome` launch.
2. Whether the CLI replaces a manifest that points at another Claude install. If it does,
   F5 must show a confirmation naming the old and new paths before the first launch.
3. A connected session (chip `Chrome on`), a successful Chrome tool call, and a denial on the
   next call after the setting is turned off.

Until that record exists and the confirmation ships, the flag stays `false`.

## Claude computer use: blocked on the consent gate

`CLAUDE_COMPUTER_USE_CERTIFIED` is `false`. Claude Code only starts its built-in
`computer-use` server in interactive terminal sessions, and its per-app `request_access`
consent needs an elicitation answer that an SDK host cannot give. Launching
`claude --computer-use-mcp` as a separate stdio server is not a supported, session-bound
backend, so F5 never starts it. With the setting on, the session reports computer use as
"unavailable", and every `mcp__computer-use__*` tool is denied by both the mandatory hook and
`canUseTool`, even if a server under that name (for example a user-configured one) connects.
No approval prompt is shown, because there is nothing safe to approve.

`computerUseLease` and the global **View** / **Stop** banner are in place for a certified
backend: only one thread may hold the computer, and every window shows the banner while it
does. Nothing acquires the lease in this build.

## F5-native computer control: blocked

`packages/contracts/src/computerAutomation.ts` defines the native backend's status, input,
and screenshot schemas. The desktop bridge exposes only
`desktopBridge.computerAutomation.status()`, which returns `available: false` with reason
`not-certified` on macOS and Windows and `unsupported-platform` elsewhere. No agent tool is installed
while it is unavailable, and Codex sessions have no computer-use path.

Certification must demonstrate all of the following before `available: true` ships:

1. Per-application consent that the agent cannot widen, matching Claude's `request_access`.
2. A user kill switch (global hotkey plus the banner) that stops input in under 100 ms.
3. Input isolation: synthesized events never reach F5's own windows or system dialogs
   (password prompts, permission sheets).
4. Screenshot redaction of F5 windows and of any app the user did not grant.
5. Screen Recording and Accessibility permission failures reported as
   `missing-permissions`, never retried silently.

Failing any item keeps the backend blocked; weakening a requirement is not an option.

## Validation

- Unit and contract tests:
  - Broker: `apps/server/src/mcp/*.test.ts`.
  - Claude: `ClaudeAdapter.test.ts`, "ClaudeAdapter agent browser" block.
  - Screenshots: `toolResultImages.test.ts`.
  - Lease: `computerUseLease.test.ts`.
  - Desktop: `automationControl.test.ts`, `computerAutomation.test.ts`.
  - Web: `PreviewBrowserHost.logic.test.ts`, `agentBrowserActivityStore.test.ts`,
    `AgentBrowserLiveCard.logic.test.ts`.
- Live Claude (opt-in, uses the account's quota): `bun run test:claude:live` includes
  `integration/claudePreviewMcp.live.test.ts`. That test lists and calls the in-process
  preview tools and checks that a real image block comes back.
- Manual desktop pass:
  - Open a loopback app, ask an agent to click and type, and use **Take over** mid-action.
  - Add an external host and confirm that a non-allowlisted redirect is blocked.
  - Confirm screenshots render as thumbnails in the timeline.
