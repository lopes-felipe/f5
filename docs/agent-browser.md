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

| Capability                | Claude                                                 | Codex                                                  |
| ------------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| F5 preview (`preview_*`)  | In-process SDK MCP server `f5_preview`                 | Loopback HTTP MCP `__f5_preview`                       |
| External sites in preview | Allowlist (`previewExternalHosts`)                     | Same allowlist                                         |
| Chrome integration        | Awaiting native-host certification (`--no-chrome`)     | Awaiting plugin certification                          |
| Computer use              | F5 native catalog when available; built-in gate closed | F5 native catalog when available; built-in gate closed |

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

## Computer use v2 architecture

Computer control is opt-in and currently **awaiting certification** on both macOS and
Windows. Linux reports `unsupported-platform`. The native implementation targets macOS
14+ and Windows 10 2004+. Setting `F5_COMPUTER_CONTROL_DEV=1` enables local engineering
validation only in unpackaged builds; it cannot enable a packaged release.

Electron main is the device authority. Every profile backend inherits a private Node IPC
channel with an incarnation UUID and a versioned hello. There is no network computer host
registration and no renderer execute method. Claude's native tools use the in-process
`f5_computer` SDK MCP server; Codex uses catalog-scoped bearer credentials on
`/mcp/computer` (`__f5_computer`). Preview and computer credentials cannot be exchanged.

Main supervises an OS-specific helper, an execution lease across profiles, bounded
mutation and observation queues, replay protection and capture-excluded overlays. A
session chooses one backend. **Automatic** prefers a built-in only when its provider,
platform and version have certified consent, per-call veto, stop, observation, F5
isolation and profile isolation. **F5 only** forces the native implementation. This
preference is user-level and cannot come from a checked-in project file. Settings and
availability changes restart the provider session at the next turn. Session bindings record
the selection, installed-tool state and configuration fingerprint; replaced Codex
processes cannot deliver lifecycle or tool events into their replacement session.

The built-in certification registry is empty. The read-only availability probe identifies
installed ChatGPT plugin version/manifest hashes without enabling or importing a global
provider home. The currently installed app ships a disabled `cua_repl` placeholder that
needs ChatGPT's dynamic launch configuration. Codex's supported hooks include
[PreToolUse denial](https://learn.chatgpt.com/docs/hooks), but its computer runtime's veto
coverage and profile isolation still require a recorded integration run.

Claude's [computer-use documentation](https://code.claude.com/docs/en/computer-use)
requires the interactive CLI and excludes non-interactive `-p` mode used by the Agent
SDK. General SDK elicitation support does not establish supported computer-use launch
or app-access consent. These are upstream integration constraints, not permission to
start an external computer-use server or weaken F5's gates.
F5 does not guess plugin configuration, copy ChatGPT resources, start
`claude --computer-use-mcp` as an external server, or install two computer catalogs into
one session. With those gates closed the selected available backend is native, with the
built-in reason shown on both providers' capability chips. If native lacks a host, platform support or certification, no
computer catalog is installed. Recoverable helper/permission/monitor failures keep the
native catalog installed and fail calls with their current reason, without restarting
the provider session. Adding a certification record alone does not install a
provider built-in: its supported launch, consent and veto bridges must be wired before
the availability probe can return true. That runtime wiring is still pending.

| Guarantee                                     | F5 native release gate     | Built-in provider gate             |
| --------------------------------------------- | -------------------------- | ---------------------------------- |
| F5-owned machine lease and global pause       | Required                   | Required                           |
| Per-call pre-execution veto                   | Required                   | Required                           |
| Consent that the agent cannot answer          | F5 app dialog              | F5 dialog or certified provider UI |
| F5 cannot be targeted                         | Per-event ownership checks | Must be demonstrated               |
| Ungranted content excluded from capture       | Required                   | No F5 guarantee                    |
| Stop under 100 ms                             | Required                   | Current provider action may finish |
| Per-event hit testing and secure focus checks | Required                   | No F5 guarantee                    |
| Persistence sanitization                      | Required                   | Required                           |

### App consent and protection tiers

Observe `computer_status` first, then `computer_list_apps` and `computer_request_access`.
Requests show a desktop dialog and a timeline card. Only a trusted user gesture in the
owning profile's registered main-frame renderer can answer, through preload and main's
private host channel. Web clients show “Answer on the computer running F5”. Requests
expire after 300 seconds; turn/session end closes them. Full-access runtime mode never
bypasses app consent, pause or protected targets. Other runtime modes also require a
session-actions approval; plan mode permits observation only.

| Tier    | Examples                                                                                                            | Rights                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| blocked | F5 (including dev Electron), security/permission/login UI, Settings, task management and system administration apps | Never grantable                                        |
| view    | Password managers, Keychain Access                                                                                  | Capture and inspect only                               |
| click   | Terminals, IDEs, automation apps, other agent apps; Windows Explorer app windows                                    | Interaction; typing requires separate **Allow typing** |
| full    | Other apps, including browsers                                                                                      | Interaction and typing                                 |

The authoritative catalog is `packages/shared/src/computerApps.ts`, generated into both
native builds and checked for drift in CI. Dock, menu-bar status items, Control Center,
Notification Center, Spotlight, Start, tray and desktop shell surfaces are never
application grants. Browsers carry “This app can act on sites you are signed in to”.
Typing into a click-tier app can run commands, so its typing checkbox starts off.

Grants last for the provider session, across turns. “Always allow in this project” writes
server-owned `computer-access.json` under `ServerConfig.stateDir`, through serialized
atomic writes. Session deny overrides a remembered grant. Revoke narrows live access;
Forget removes a remembered grant from project settings. Restart retains remembered
grants and drops session grants. Settings patches and model tool calls cannot add grants.
An agent with unrestricted filesystem write access can still edit these files; the
no-widening guarantee applies to the tool and consent paths.

### Capture, coordinates and accessibility

Native screenshots include granted apps only. macOS uses ScreenCaptureKit include-only
application filters; Windows composes granted top-level windows with `PrintWindow` onto a
neutral canvas and never reads desktop pixels. F5 and overlays are excluded; known secure
fields in the focused window are masked before encoding. `hiddenContent` indicates that
on-screen windows were omitted or privacy masking hid content. Capture enables Chromium
accessibility before reading password fields; a truncated or unreadable masking tree hides
the focused window conservatively. AX calls have a process-wide 250 ms timeout.
An unreadable accessibility tree produces an empty,
inaccessible inspect result; it does not expose secure values through inspect/setValue.

Each display has a geometry generation covering bounds, physical pixel size, scale and
rotation. Negative origins and mixed DPI are supported by the coordinate contracts.
macOS pixel dimensions use the display mode backing resolution. Windows full-window
captures are cropped to the visible DWM frame before composition, preserving coordinates.
Coordinate input uses the actual Windows hit recipient, rejects cloaked, transparent and
ambiguous layered targets, and verifies window regions.
Model dimensions use `s = min(1, 1456 / longEdgePx, sqrt(1150000 / areaPx))` and floor the
scaled dimensions. Coordinates are integer pixels in that display's screenshot, with
exclusive upper bounds. They map through pixel centers into native space. Zoom is viewing
only; clicks always use display screenshot space. Coordinate tools require a fresh
screenshot's generation. Geometry changes fail instead of remapping silently.

Zoom crops an approved region from a sharper capture before image-size scaling; its
rectangle uses the original display screenshot coordinates. Zoom images are for viewing
only and do not replace the display geometry used for clicks.

Prefer `computer_inspect` and `computer_element_action` for accessible elements. Native
AX/UIA actions re-resolve opaque snapshot references against the live app/window and
refuse stale or secure elements. Unsupported actions return an explicit error and do not
fall back to coordinate input. Coordinate actions drive the foreground pointer and
keyboard, hit-test each emitted event, and recheck focus and grants between typing
chunks. Open/activate operations resolve apps through native installed-app catalogs;
there is no shell, arbitrary executable path or raw native message tool.

Capture images are at most 8 MiB encoded; inspect is bounded to 400 nodes, depth 30 and
256 KiB; other results are 64 KiB and complete tool responses 16 MiB. Screenshot results
reach the model intact. Persisted images use the existing attachment pipeline, with a
200-image and 64 MiB per-thread budget; excess images count as `mcpImagesOmitted`. Computer
screenshots in plan mode are not persisted.

### Stop, pause and failure handling

The helper starts suspended and takes a per-user OS device lock. Another F5 build holding
that lock reports `other-instance`. Main grants one execution lease across profiles and
renews a monotonic one-second execution permit every 250 ms. Main stalls or channel loss
therefore suspend input locally. Helpers release held buttons/keys on cancel or suspend.
Their input monitor and heartbeat must remain healthy; an unhealthy monitor blocks input.
Windows verifies mouse and keyboard hook acknowledgments independently. Hook callbacks
set atomic stop flags; a separate worker releases held input.

The fixed kill chords are **⌃⌘Esc** on macOS and **Ctrl+Alt+Shift+F12** on Windows. Physical
keyboard/button input or sufficient mouse movement also self-suspends the helper before
notifying main. Main drains queued actions, latches pause, invalidates the lease, clears
visuals, and notifies the backend. A native suspend without acknowledgment within 50 ms
kills the helper; any replacement starts suspended and receives the current grants
again. Idle unavailable status never performs a timed suspend round trip. Heartbeat
health is separate from generation-specific permit-expiry notifications, so an old
suspended heartbeat cannot pause a new lease. Banner/live-card Stop suspends locally
before interrupting the provider turn. Resume is explicit and invalidates screenshot
geometry. Already-delivered OS actions cannot be undone.

Lease release is exact-holder and generation-aware. Turns release execution while keeping
grants; session disposal clears grants. Idle leases release after 60 seconds without a
mutation. Other profiles receive only an anonymous lease banner. Activity, app names, action
thumbnails and lease-holder metadata stay in the controlling profile.
Renderer loss affects UI only; main and helper retain the control/stop path. Backend IPC
disconnection cancels work and releases that backend's lease. Losing host/helper during a
mutation reports `OutcomeUnknown`: take a screenshot before retrying. Mutations are never
retried automatically after ambiguity. Duplicate request IDs join the admitted result;
different payload hashes are rejected and evicted IDs remain tombstones for their
execution generation.

Screen Recording/Accessibility permission failures and periodic macOS Screen Recording
re-prompts report `missing-permissions`. F5 opens the appropriate Settings pane only on
explicit user action; capture errors never silently invoke a permission prompt. Main and
helper permission identities must agree before release certification.

### Visual feedback and persistence

Main shows click-through, protected overlay windows on every display, with provider
colors, a labelled cursor, action labels and click ripples. Pause, release and display
changes clear/rebuild overlays. Chat shows transient activity, available action thumbnails,
granted apps with Revoke, and Pause/Resume/Stop. Thumbnails travel on `computer.activity`
and are not persisted. Native control of real browsers is separate from structured DOM
control, which remains in the F5 preview.

Adapter logging and central ingestion sanitize verified computer-tool provenance before
persistence. Typed text, semantic values, inspect names/values and raw error strings are
removed, including nested fields. Codex built-in `cua_repl` JavaScript and text output are
entirely omitted. This does not modify model-facing results or erase provider-managed
conversation history. Look-alike project server names do not acquire trusted provenance.

## Chrome integrations and native-host transactions

Claude in Chrome and Codex's bundled Chrome plugin remain **uncertified**. Claude is
launched with `--no-chrome`, user overrides are stripped, and built-in Chrome calls remain
denied. No native-host registration is changed by this build.

`chromeSessionRuntime.ts` connects the shared inspection/transaction primitives to
Claude's SDK launch, the mandatory pre-tool hook, trusted desktop setup consent and
main's Chrome lease. Both the descriptor registry and main's platform/provider gates
must certify an installed executable before `--chrome` can be selected. The descriptor
pins its executable hash, browser roots, native-host names, expected profile target,
server provenance verifier and evidence. User launch flags cannot bypass this decision.

Setup consent names the previous and proposed host paths and travels only over the
private host channel. After consent F5 rechecks registration hashes before launch and
records post-launch changes, including safely recognized changes from a partial launch.
Every call rechecks the main-owned lease, pause, live policy and registration drift;
approval waits recheck them again. A failed or unverifiable server is denied for the
session and changes its next-turn restart fingerprint. The lease survives until the
CLI exits. The first release conservatively excludes **all** native input while a
Chrome session holds the lease, rather than allowing concurrent input in other apps.
Chrome admission also requires a healthy native helper/device lock and a registered
emergency shortcut. Other profiles receive only anonymous lease ownership.

`chromeNativeHostStorage.ts` persists transactions atomically under server-owned
`claude-chrome/transactions/` and `codex-chrome/transactions/` directories, with bounded
reads and UUID/provider/profile identity checks. These files are not settings. Settings
shows setup history for initialized certified runtimes. Restore stops the profile's
Chrome sessions, reserves the machine lease, and restores only registrations whose
post-launch hashes still match; externally changed entries are reported as skipped.
File restoration is atomic. Windows restoration checks the certified registry key/view,
restores the original manifest bytes and original default value, or deletes only an
originally absent registration. OS-specific restoration and discovery still require the
recorded machine tests. Runtime initialization after restart requires a matching
certified installed version before its restoration history becomes available.

The shared coordinator supports both provider descriptors, but Codex's plugin launch
and pre-execution veto bridge remain unavailable until a supported isolated runtime is
identified and certified. No descriptor is fabricated for either provider. These code
paths do not enable an integration while the gates remain closed.

## Certification and validation

No signed-build certification is claimed. Native platform flags, provider built-in
records and Chrome descriptors remain closed until the tests below pass. Hosted CI and
unit tests do not establish TCC attribution, consent integrity, capture isolation or real
stop latency. Record build hash, OS/arch, helper signature/team, permission identity,
provider/installed version, app/action matrix, measurements and proving artifacts.

| Original release requirement                             | Required signed-machine proof                                                                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Per-app consent cannot be widened by the agent        | Trusted user consent, blocked/F5 rejection, web-only read-only card, incarnation mismatch, grant/revoke/forget and restart checks                  |
| 2. Stop input in under 100 ms                            | Key-logging test app under sustained input; repeat with renderer hung and backend stopped; chords must not trigger system actions                  |
| 3. Input never reaches F5/system dialogs                 | Mid-type focus/dialog changes, protected password fields, cross-F5 drag, terminal without typing, elevated Windows owner and semantic action tests |
| 4. Ungranted/F5 content never appears in captures        | Moving windows, notifications, Dock/Start/tray, packaged Windows apps, secure fields and overlays on both monitors/fullscreen Spaces               |
| 5. Permission failures are surfaced without silent retry | Revoke Accessibility/Screen Recording, SCK decline, periodic re-prompt and helper/main attribution mismatch                                        |
| Signed packaging                                         | Universal macOS helper signature/notarization and Windows signature verification; installed helper path confined to resources                      |

Run each provider through TextEdit/Notepad, Preview/Calculator, an Electron semantic
workflow and a multi-app workflow. Include mixed-DPI monitors, rotation/negative origins,
physical-input pause/resume with fresh geometry, multiple profiles, dev+packaged contention,
monitor loss, permit expiry and control with all macOS F5 windows closed. Benchmark Windows
include-only composition on 50 windows (target <150 ms release build).

Built-ins additionally require recorded enablement, user consent, F5 pre-call veto, stop
behavior, targetability of F5/blocked apps, screenshot scaling (Claude), and Codex plugin
reads/writes under its configured `CODEX_HOME`. No provider credential/state from another
F5 profile may be accessed. Publish the weaker guarantees in the table above alongside
actual measurements. Chrome certification must record all registration changes,
concurrency behavior, successful calls, live policy/pause denial and byte-for-byte restore.

Repository gates: `bun fmt`, `bun lint`, `bun typecheck`, `bun run test:full` and
`bun run test:desktop-smoke`. Never use `bun test`. Native checks are `swift test`,
`cargo test`, generated-tier drift and helper hello/permissions protocol checks. Live
provider tests are opt-in and consume account quota; they do not replace signed-machine
certification. Existing preview broker regression tests remain unchanged.

`integration/computerMcp.test.ts` exercises the authenticated HTTP catalog against a
controlled IPC host: catalog discovery, app consent, a model-readable image block, action
authorization, session-action approval, pause rejection and credential cleanup. The opt-in
`claudeComputerMcp.live.test.ts` and `codexComputerMcp.live.test.ts` add real provider tool
discovery and image/action transport. Their host simulates an app and does **not** inject
OS input; signed-machine actions and the isolation/latency checks still need the manual
matrix above. Codex records additional approval methods and rejects unexpected requests.

## Review follow-up and remaining release work

Native policy tests now exercise both tier tables, blocked chords, interrupted input,
held-input release, device-lock contention, window recipient exclusions and independent
hook failure. They do not replace real OS recipient/capture tests, the complete planned
native authorization matrix, Windows execution or signed-machine certification.
Native tests now call the same focus, owner, secure-element, chord and menu-region
policies as the helpers. Windows composition tests exercise the actual pixel cropping
and alpha composition used by capture, including invisible borders and negative origins.
Claude Chrome launch/consent/lease/veto/restore consumers are connected behind empty
certification records. Provider built-in launch bridges and Codex Chrome plugin wiring
remain unavailable for the integration constraints above. No native, built-in or Chrome
release gate was enabled by this work.

Transport admission joins concurrent retries by MCP request identity and retains completed
IDs as tombstones. A late retry gets `ReplayRejected` rather than repeating input.
Post-action captures can return `screenshotError` alongside `actionCompleted: true`; a
failed capture does not turn a delivered action into an input failure. Positive vertical
scroll deltas mean down, and positive horizontal deltas mean right. Ambiguous app queries
return candidate identities instead of adding every match to a default-selected card.

The Codex process-liveness guards are required to keep retired process events from
changing a replacement session and its computer authority. The Claude rejected-resume
fix is broader than computer use: the existing “reports the first turn after a rejected
resume point as not sent” regression requires `deliveryRetryable: false`, so a rejected
resume cannot trigger an automatic resend. It remains included as an explicitly identified
prerequisite bug fix and is covered by that adapter test, including sessions with computer
use disabled.

To collect a preflight without granting access or injecting input, run:

```sh
bun scripts/record-computer-certification.ts --app /Applications/F5.app --output /tmp/f5-certification.json --build-commit <installed-build-commit>
```

For a development binary use `--helper <path>` instead of `--app`. The recorder hashes
and verifies signatures, starts the helper suspended and observes permissions only.
It refuses to overwrite a report and leaves every machine-test item pending with
`certified: false`. It records repository and installed-build commits separately; a
preflight never proves TCC identity, real capture isolation or input-stop latency.
