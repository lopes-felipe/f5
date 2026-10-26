# Agent browser and computer use

> Contributors: the technical reference for agent browser and computer-use automation. For setup, see [Agent browser and computer use](user/agent-browser-and-computer-use.md).

**Contents:** [macOS opt-in preview](#macos-opt-in-preview) · [Rule: tools installed, execution gated](#rule-tools-installed-execution-gated) · [F5 preview](#f5-preview) · [External sites allowlist](#external-sites-allowlist) · [Computer use v2 architecture](#computer-use-v2-architecture) · [Provider-native integrations](#provider-native-integrations) · [Certification and validation](#certification-and-validation)

How agents (Claude and Codex) see and drive web pages and, optionally, this computer, and
the safety rules each path follows. Settings live in **Settings → Browser & Computer** and
per project in the Browser & Computer category of project settings. Every flag below is ANDed with
`enableAgentBrowserAccess`. A checked-in `f5.json` can never set `previewExternalHosts`,
`enableClaudeInChrome`, `enableCodexChrome`, or `enableAgentComputerUse`
(`USER_ONLY_PROJECT_SETTING_KEYS`).

## macOS opt-in preview

macOS 14+ native computer control is available in development and packaged builds as
an **uncertified, opt-in preview**. In Settings → Browser & Computer, enable Agent
browser access and Computer use (preview), grant Screen Recording and Accessibility
in System Settings, then start a new Claude or Codex turn and approve each app in
F5's native dialog. Defaults remain off. Your input pauses control; ⌃⌘Esc stops it.
Pause blocks screenshots, zoom and inspection as well as input. Status/app metadata
remain available to explain the pause.

This availability change does **not** certify the existing or new binaries. All
`COMPUTER_CONTROL_CERTIFIED` constants remain false. Signed installed-build/TCC,
full protection/display coverage and Windows interactive evidence remain pending.
Windows and provider built-in computer control stay unavailable. Provider-native Chrome
integrations open only through a certification record (see
[Provider-native integrations](#provider-native-integrations)); no record certifies yet.
Prior machine receipts remain evidence for their recorded binaries only.

Project grants contain opaque receipts issued and checked by Electron main. Editing
`computer-access.json` cannot mint an approval. In this preview, receipts live only
in main memory: remembered approvals survive backend restarts while F5 is running,
but restarting F5 requires genuine consent again. A session revoke also prevents
replaying its old receipt. Native dialogs identify the bundle ID/executable and
quote the agent's unverified reason after F5's own instructions.

Every macOS desktop backend and its descendants run under a kernel sandbox that
blocks Apple Events, synthesized HID control, WindowServer/capture/accessibility service connections,
LaunchServices GUI launch, launchd job creation and privileged task ports. It applies
even when computer use is off, because another profile or SnapShot may already have
obtained F5's permissions. Filesystem/network coding tools retain their existing
access; shell GUI automation must use F5's consent-mediated computer catalog.
There is no unsandboxed fallback if the sandbox launcher fails.

Every included window is audited for secure fields, including background apps and
second windows. Missing, partial or timed-out accessibility scans mask the nearest
containing web/scroll area, or the window when no such region is known.
The default fast mode uses best-effort browser accessibility search: visible password
fields omitted by Chrome can remain in the image. Conservative mode walks the tree.

## Rule: tools installed, execution gated

Preview tools are installed in every interactive desktop session. Each call resolves the
live policy (`resolveAgentBrowserPolicy`), so toggling a setting applies on the next tool
call without restarting the session. Policy lookups fail closed.

| Capability                | Claude                                                                                | Codex                                                                                             | ACP (Cursor, Grok, Antigravity)                                         |
| ------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| F5 preview (`preview_*`)  | In-process SDK MCP `f5_preview`                                                       | Loopback HTTP MCP `__f5_preview`                                                                  | Awaiting per-harness preview startup verification                       |
| External sites in preview | Allowlist (`previewExternalHosts`)                                                    | Same allowlist                                                                                    | Same live allowlist                                                     |
| Chrome integration        | Claude in Chrome (`--chrome`) once `claude-chrome` certifies; `--no-chrome` otherwise | ChatGPT for Chrome through F5's `node_repl` proxy once `codex-chrome` certifies; Full access only | Unsupported                                                             |
| Computer use              | F5 native; Claude's built-in starts only in interactive terminals                     | F5 native; Sky (`codex-builtin`) gate closed pending the spike                                    | Awaiting per-harness live verification; no executable catalog installed |

### ACP harnesses

The read-only `bun apps/server/scripts/acp-capability-probe.ts` sends only `initialize`;
it never authenticates or creates a session. Use `--state-dir <profile-state-dir>` to
probe an existing managed Antigravity installation. The [2026-10-18 probe report](computer-certification/2026-10-18-acp-capability-probe.json)
records Cursor `2026.07.09-a3815c0` advertising HTTP and SSE. Grok was not installed;
Antigravity had no selected managed installation. HTTP is selected for Cursor. There
is no evidence requiring the conditional stdio shim; non-HTTP harnesses receive no
F5 catalog until that transport is implemented and checked.

ACP preview installation is closed by the frozen `ACP_PREVIEW_CATALOG_VERIFIED` flags (all false). Once a harness passes a preview-only startup/inventory run, ordinary desktop sessions can install tools lazily after negotiation, with
an unguessable server name and one credential per runtime. New, load, resume and
fallback payloads use the same memoized list. Read-only workflows, synthetic turns
and external runtimes do not install these catalogs. Browser access is checked on
every call, so enabling it requires no restart. Computer policy and execution-mode
changes also never trigger an ACP conversation restart.

The [control run](computer-certification/2026-10-18-acp-preview-review-control.json) and
[preview-only run](computer-certification/2026-10-18-acp-preview-review-preview.json)
both timed out during `authenticate`, before `session/new` sent any MCP configuration.
This identifies a startup blocker independent of MCP installation, but proves no live
preview compatibility. The opt-in `F5_ACP_PREVIEW_LIVE=cursor` suite in
`integration/acpPreviewMcp.live.test.ts` compares both paths and lists the model's preview
inventory only after startup succeeds. Tests inject verification overrides; production
verification records are frozen and cannot be changed by the live suite.

Every ACP log boundary structurally redacts nested MCP header/env values, including
serialized frames. Unparseable frames become a fixed marker. Session-owned exact
credential scrubbers also remove echoed credentials from diagnostics and remain
alive for late producer callbacks after token revocation. Credentials are revoked
immediately on disposal; retaining a scrubber confers no execution authority. Ordinary
sessions keep readable setup, authentication and transport diagnostics with scrubbed
causes. Fixed setup codes apply only when a computer-capable lineage or installed F5
catalog could expose private configuration. Computer-capable logs additionally mask
error/cause details; structural credential redaction applies to every ACP session.

Computer catalogs remain closed by `ACP_COMPUTER_CATALOG_VERIFIED` (all false).
Installing one additionally requires a desktop that negotiated
`computer-agent-identity-v1`. F5 never impersonates Claude or Codex for an old desktop.
`computer-activity-correlation-v1` is independent of identity and background execution;
old desktops retain summaries but their uncorrelated native thumbnails are suppressed.

When the computer integration is exercised in tests, exact identity can only be
established by captured, verified harness metadata. No such parser has been certified.
Otherwise classification fails closed: tool inputs must be provably native to remain
visible. Unknown IDs, update-only events, permissions and replayed tool calls are
redacted. A persistent boolean records computer-capable session lineage; no inventory
of screen content or typed strings is persisted. Raw/decoded logs and adapter mapping
use the same classifier. Computer-session prompts are hidden from native logs too.

Unknown permissions always ask with hidden inputs, including in full-access mode.
They never inherit an F5 exemption from their title, kind or a look-alike server name.
A future exact-identity parser may allow only the harness's allow-once option; F5's
broker still owns live policy, session consent, per-app grants and plan-mode vetoes.
Harness plan-mode limitations must be reported, never worked around by relaxing mode.

Adapters retain provenance synchronously at admission, prepare/sanitize events before
enqueueing them, then release it. Only the existing recognized image-result shapes can
be persisted; other image/content shapes are dropped. Authenticated `computer.activity`
events supply detailed activity and thumbnails independently of provider tool output.
Cleanup finalizers run after runtime shutdown, including failed authentication,
startup interruption, failed session creation and failed configuration.

`F5_ACP_COMPUTER_LIVE=cursor|grok|antigravity bun run --cwd apps/server test:file integration/acpComputerMcp.live.test.ts`
is an explicit opt-in transport/privacy probe using simulated input and delayed fixture
consent. The [Cursor startup attempt](computer-certification/2026-10-18-acp-cursor-live.json) timed out and is not eligible to open a gate. `F5_ACP_COMPUTER_REPORT` saves its bounded result. It does **not** constitute
complete harness certification: held takeovers, harness-native plan-mode behavior and
unrelated-session attribution also need live evidence. A separate PR per harness must
attach complete passing conformance/privacy evidence before flipping its flag.

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
validation only in unpackaged builds; it cannot enable a certified release. The macOS preview now has a separate explicit availability flag.

For local use from this checkout, build with `bun run build:desktop`, quit any
existing F5 instance, then launch with
`F5_COMPUTER_CONTROL_DEV=1 bun run --cwd apps/desktop start`. Enable **Computer use**
in Settings → Browser & Computer, grant the missing OS permissions, and start a new
provider session. The root desktop launch also passes this development flag
through Turbo. A running app must be restarted to receive the flag; setting it
in a different shell cannot change the existing process. This remains an
uncertified development path, and the flag is ignored by packaged builds. macOS preview availability is explicitly enabled by `COMPUTER_CONTROL_PREVIEW`, independently of certification.

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
preference is user-level and cannot come from a checked-in project file. Claude/Codex backend selection changes can restart the provider session at the next turn;
ACP policy changes apply live and never restart its conversation. Session bindings record
the selection, installed-tool state and configuration fingerprint; replaced Codex
processes cannot deliver lifecycle or tool events into their replacement session.

The built-in certification registry is empty. The read-only availability probe identifies
installed ChatGPT plugin version/manifest hashes without enabling or importing a global
provider home. The currently installed app ships a disabled `cua_repl` placeholder that
needs ChatGPT's dynamic launch configuration. The bundled Chrome plugin has no
standalone MCP launch definition; its skill expects a host-provided `node_repl` runtime.
The readiness probe distinguishes these installed, host-managed plugins from missing or
unreadable installations and records both versions and manifest hashes in the preflight.
Codex's [hook documentation](https://learn.chatgpt.com/docs/hooks) supports explicit
PreToolUse denial but specifies fail-open behavior for callback failures and specialized
paths that can omit the gate. A hook alone cannot supply F5's fail-closed veto. Supported
runtime launch, complete veto coverage and profile isolation remain integration gates.

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

### Observation, controls and history

`computer_wait` replaces repeated screenshot polling. With no condition it settles
for 2 seconds by default; with `app` and an exact `role` and/or `name`, it waits up to
5 seconds for presence. `timeoutMs` is 100–10,000 ms. Presence attempts inspect at
most 100 nodes and back off 250 ms, 500 ms, then 1 second. Partial trees can prove
presence, never absence. One monotonic deadline covers resolution, IPC and sleep;
pause, turn end, session replacement, policy and grant changes interrupt the wait.
Only one wait runs per session. `screenshot: true` captures afterwards; a failed
capture still returns the wait metadata. Status carries the full guidance; actions
carry a short safety clause. The 17 descriptions total 4,368 characters (4,424 when
serialized as a JSON array), below 6,000 and over 50% below the old repeated guidance.
MCP initialization and Claude SDK registration additionally carry server instructions.
The macOS 300 ms settling delay is unchanged; no new native timing certification is claimed.

Captures are invalidated at mutation admission and on pause, grant/policy changes,
session replacement and reconnect. The broker admits images only for the current
request, generation and observation epoch. Late completions never restore an old
thumbnail. Success without a capture and failed captures clear it as well.

Pause all snapshots its targets and sets every one to paused. Stop independently
attempts suspension and turn interruption for each target, retaining failures from
both stages. Failed or unconfirmed targets remain **Stop unconfirmed** with an
explicit Retry Stop; there is no automatic retry. Retained pause/recovery summaries
carry `leaseHeld: false` only after authoritative host release. Check the app after
`OutcomeUnknown`, then observe before another action. Resume requires the trusted
local confirmation; remote clients explain where to resume. The stop shortcut is
**⌃⌘Esc** for the Mac host, including when operated remotely.

Pending computer consent participates in existing badge, sound, toast and system
notification attention. The dialog identifies the project/thread, shows its actual
deadline and counts other waiting requests. Sidebar and home status pills are unchanged.
Only the WebSocket push carries `expiresAtMs`; the native consent request is unchanged.

The live card's Actions popover keeps the last 30 tool outcomes per thread. The
server tool layer alone publishes history via `source: "tool"`, so desktop and tool
failure notifications cannot duplicate a row. Successful tool summaries do not touch
the current capture. Access-request storage keeps at most 20 settled entries per
thread and 200 globally; pending requests survive pruning. Both histories reset on
connection replacement. Idle cards have no timer; completed activity and lease-release
feedback schedule only the next expiry. Computer timeline headings require authenticated
provenance, carried as `computerTool`; server names alone never create that heading.

### App consent and protection tiers

Observe `computer_status` first, then `computer_list_apps` and `computer_request_access`.
Requests show a desktop dialog and a timeline card. **Review access** opens native dialogs
owned by Electron main. The renderer only identifies the pending request; its allowance,
typing, remembering and session-action fields are ignored. Native dialog choices alone
produce the answer on the owning profile's private host channel. Requesting app consent
releases existing native execution before the dialog is shown. Cancel defaults to deny;
main revalidates request expiry and backend incarnation after every dialog. Resume of actual
computer control also requires a native confirmation, independently of renderer gestures. Web clients show “Answer on the computer running F5”. Requests
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
Typing into a click-tier app can run commands. Its native dialog defaults to Deny and
separates **Allow clicks** from **Allow clicks and typing**; remembering defaults off.
`computer_request_access` accepts `typing: true` to request a typing upgrade after click-only
access. Ordinary duplicate requests do not prompt again, and a declined typing upgrade is
not prompted again within the same turn. Full-tier native approval explicitly says
**Allow control and typing**. Unknown apps retain the plan's full-tier ceiling; identity
classification is not a sandbox and consent is required for every app.

Grants last for the provider session, across turns. “Remember for this project while F5
is running” writes main-issued receipts to server-owned `computer-access.json` under
`ServerConfig.stateDir`, through serialized atomic writes. Invalid or incompatible files are quarantined with their original bytes
preserved and startup continues without remembered grants. If quarantine fails, remembering
is disabled until storage is repaired. Session deny overrides a remembered grant. Revoke narrows live access;
Forget removes a remembered grant from project settings. A backend restart retains
remembered grants only while desktop main remains open; restarting F5 expires them.
Settings patches and model tool calls cannot add grants. Filesystem edits cannot
mint a main-owned approval receipt, widen its rights or reuse a receipt after it has
been revoked in that session. Unrestricted filesystem access still permits modifying
other user files; these grants are not a general filesystem sandbox.
These controls govern F5's computer tools, not every command an unrestricted shell
can run. For desktop macOS profiles, separate AppleScript/`osascript`, capture and native Accessibility programs are blocked by the backend sandbox rather than inheriting F5 permissions. For separately launched headless servers, such programs are subject
to macOS permissions and its own execution policy; the F5 computer lease and pause
cannot supervise an independent process that bypasses this tool interface.

### Capture, coordinates and accessibility

Native screenshots include granted apps only. macOS uses ScreenCaptureKit include-only
application filters; Windows composes granted top-level windows with `PrintWindow` onto a
neutral canvas and never reads desktop pixels. F5 and overlays are excluded; detected secure
fields in included windows are masked before encoding. `hiddenContent` indicates that
on-screen windows were omitted or privacy masking hid content. Capture enables Chromium
accessibility before reading password fields. On macOS, the profile-global
`computerUsePasswordMasking` setting defaults to `fast`; `conservative` bypasses web-area
search. Both modes retain a 20,000-node / 256-depth / 2-second capture audit budget
and mask unaudited regions. AX calls have a process-wide 250 ms timeout.
The broker injects the mode into the hashed internal envelope, including action captures,
wait captures and zoom; agents cannot override it. The experimental environment switch
no longer controls masking. Missing request mode retains the conservative legacy walk.
Screenshots report the actual mode in `passwordMasking`; older helpers and Windows omit
it and are labeled Legacy / unknown. The helper status advertises `passwordMaskingSupported`.
An audit's `complete` flag means its calls finished, not that Chrome exposed every field.
The 50,050-node Chrome fixture has demonstrated both delayed-frame and nested-frame
password misses with successful search audits; settled captures that pass do not negate
these known coverage limitations.
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
screenshots in plan mode are not persisted. The native NDJSON line limit is separately
12 MiB; both helpers return a correlated `ResultTooLarge` for oversized responses.
This differs from the complete MCP tool-response limit of 16 MiB.

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
execution generation. Transport dispatchers keep at most 65,536 invocation tombstones per
MCP initialization and refuse new IDs at saturation. Completed observation IDs are retained
as well: expiring an ID could change a late retry from rejected into a fresh call. MCP
re-initialization creates a new invocation identity scope, rejects retired session headers,
and does not deduplicate calls made with a new scope. After `OutcomeUnknown`, a client must
observe before deliberately issuing any new action; it must never automatically re-submit
a mutation after reconnect. This boundary is covered by the mutation re-initialization test.
Preview-only pause/resume remains available with missing or unhealthy computer helpers;
remote resume is refused for a held native/Chrome lease or a main-authoritative computer pause.

Overlay rendering is bounded to 280 ms and cancellation releases its queue slot without
allowing late dispatch. If an observation worker blocks in another app (including Windows
`PrintWindow`), the 10 s supervisor timeout suspends and retires the helper; replacements
start suspended and no action is retried. Three such failures in 60 s require explicit Retry.

Screen Recording/Accessibility permission failures and periodic macOS Screen Recording
re-prompts report `missing-permissions`. F5 opens the appropriate Settings pane only on
explicit user action; capture errors never silently invoke a permission prompt. Main and
helper permission identities must agree before release certification.

### Background delivery and per-app leases

Settings → Browser & Computer → Computer use → Execution mode chooses `foreground` (default) or `background`
(`computerUseExecutionMode`, machine-wide, no project override). Background lets each agent
act inside one named, granted app through Accessibility without moving the pointer or
changing focus, so the user keeps working. It is a macOS-only preview, open by default
(`COMPUTER_BACKGROUND_PREVIEW` in `apps/desktop/src/computer/certification.ts`; with the gate
closed, unpackaged builds can still opt in with `F5_COMPUTER_BACKGROUND_DEV=1`). Foreground
remains the default execution mode. When the preference is background but delivery is unavailable, tools
fail with the reason (`unsupported-platform`, `peer-capability`, `preview-off`,
`permissions`, `monitor-unhealthy`) instead of silently using the foreground.

Peers negotiate `background-ax-v1` without changing protocol version 1: the backend hello
lists capabilities, Electron answers with `hostCapabilities`, and the helper hello lists its
own (current helpers always list `background-ax-v1`). A legacy peer on any hop keeps the thread
foreground-only and receives only the legacy single-holder `leaseChanged` message. Electron
answers with the capability only while the background preview gate is open, so with the gate
closed every user stays on that legacy protocol and no background path (receipts, policy
revisions, `observationInvalidate`, execution states) runs. A thread's policy revision keeps
increasing across provider-session replacement, matching Electron's per-thread minimum.

Leases have a scope: `foreground`, `app` (background, one app) or `takeover` (foreground for
one app, bound to a native approval receipt). One lease per thread; several threads may hold
`app` leases for different apps at once. `app` leases on the same app conflict, and a
foreground or takeover lease conflicts with everything. Chrome/browser-integration leases
are foreground. The helper keeps a permit per execution generation, so suspending, draining
or retiring one thread never affects another; physical input tagged to a target app stops
only the thread acting in it, while untagged input pauses foreground holders only.

The first background mutation in a session needs a native session approval (“F5 may keep
acting in granted apps while you work elsewhere”), including full-access sessions. Electron
mints the session receipt; it is bound to profile, backend incarnation, thread, session and
policy revision. Every tool call is classified before display selection or screenshot
preparation:

- `screenshot`, `zoom`, `type`, `inspect`, `openApp` and `elementAction` (`press` and
  `setValue` only) need `app` in background;
  otherwise the tool reports `app-required` (“Specify app: the app to act in.”).
- App screenshots show only that app's windows (`captureScope: "app"`, no cursor or menu
  bar) and never authorize display coordinates.
- `type` inserts text through accessibility and reads it back; `verification.verified:
false` means confirm with inspect or a screenshot. Secure text entry waits
  (`waiting: "secure-input"`).
- `click`, `drag`, `scroll`, `key`, `move` and `activateApp` report `ForegroundRequired`.
  Apps listed in `COMPUTER_BACKGROUND_POLICY.foregroundOnly` and apps that activate
  themselves during background actions also require the foreground.

`computer_request_foreground {app, reason}` asks for an explicit takeover of one app. Electron
reserves the takeover, shows a native dialog quoting the reason, waits until the user's input
has been idle for 1.5 s (30 s limit), drains every background holder, then asks the helper
for its current idle age and input sequence and arms the lease. The helper resumes the armed
generation only if its input sequence is unchanged; any input in between stops it. The approval
must name the reservation's exact thread, session, turn and app, or no receipt is minted.
Foreground steps on that app reuse it until the turn ends, the agent
passes `executionMode: "background"`, or a stop/policy event revokes it. While a takeover is
armed, other threads get `TargetBlocked foreground-busy`; acting in another app reports
`TargetBlocked other-app`. If the user is using the target app, background actions report
`TargetBlocked user-active` without latching a pause.

A settings change that alters effective computer policy (computer use, execution mode,
backend, browser access, or those per-project overrides) runs a policy admission barrier: the
server closes admissions, bumps the affected bindings' policy revision (every thread for global
changes, only that project's threads for overrides), cancels pending consent/takeovers and
execution, sends `observationInvalidate` and awaits its drain, applies the change and reopens.
Unrelated edits never pass the barrier. Electron rejects older revisions afterwards and the
session approval must be granted again. Background mode forces the F5 native backend.

Interruptions before dispatch report `Interrupted`; after dispatch, `OutcomeUnknown`, which
puts the thread into recovery until the user resumes locally. This covers cancellation,
timeouts and helper loss alike, and partially typed text. A dispatched mutation keeps
excluding conflicting scopes (including Chrome) after its lease is released, until the helper
answers or a drain confirms. A generation still stuck in its app after the helper's 5 s drain
bound reports `drained: false`: that work stays excluded and is drained again, a takeover
gets `foreground-busy`, and the shared helper is retired only if it stops answering
altogether. When the helper confirmed the OS action before an optional
screenshot, a later stop keeps `actionCompleted: true` and reports only `screenshotError`.
Only AX errors that prove nothing was written fall back to `ForegroundRequired
typing-unsupported`. Screenshots finishing after an invalidation are discarded and
app-scoped captures never authorize coordinates. The banner and live card show every
holder with its delivery, app, execution state (`active`, `waiting-secure-input`, `paused`,
`recovery`, pending takeover) and pause cause; background-only control uses a quieter style.

`bun apps/desktop/src/computer/rehearseBackgroundMacos.ts` is the Phase 0 delivery spike for
the certified background apps; it writes a bounded metadata report to
`docs/computer-certification/<date>-macos-background-delivery-spike.json`.

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
Verified tool identities survive nested Claude and Codex lifecycle envelopes, so MCP
cards show the server/tool name and sanitized summaries. Redacted historical metadata
cannot be reconstructed from the stored generic card. Raw tool I/O remains available
to the model but is never restored to these persisted cards.
The sanitizer retains at most 65,536 item/block identities across active sessions. At
saturation it conservatively redacts subsequent events for affected computer-enabled
threads until session release, rather than forgetting an identity and leaking late results.
Before queue admission, both adapters store bounded computer screenshots through the
attachment registry and enqueue only sanitized summaries and attachment references.
Missing storage, unknown threads, plan mode, or exhausted image budgets produce an
omitted count. Queued references survive session/provenance disposal. Central ingestion
keeps these references when creating activities and still extracts other MCP images.

## Provider-native integrations

| Integration      | Record           | Path                                                       | Lease                | Status         |
| ---------------- | ---------------- | ---------------------------------------------------------- | -------------------- | -------------- |
| Claude in Chrome | `claude-chrome`  | CLI `--chrome`, native host registered by the CLI          | Whole session        | Gate closed    |
| Codex Chrome     | `codex-chrome`   | F5 HTTP MCP `node_repl` proxying ChatGPT.app's `node_repl` | Child's lifetime     | Gate closed    |
| Codex Sky        | `codex-computer` | Proxy to `SkyComputerUseClient mcp` (spike only)           | Foreground, per call | No record      |
| Claude built-in  | none             | The CLI starts computer use only in interactive terminals  | n/a                  | Not applicable |

### Single certification source

`packages/shared/src/providerIntegrationCertification.ts` embeds the records in
`packages/shared/src/certification/*.generated.json`. `isIntegrationCertified(integration,
platform, arch)` is the only gate; desktop main's Chrome lease, the server's availability
checks and computer backend selection all call it, so they cannot disagree. A record
certifies only with an `evidenceId` naming a scrubbed report in
`docs/computer-certification/<evidenceId>.json`, the `evidenceCommit` (the clean F5
commit that run exercised), and what its runtime needs to work: `toolNames` for Claude,
`toolInventorySha256` plus advertised definitions for every allowed tool for Codex
Chrome, and `toolInventorySha256` for Sky. Runtime never reads `docs/`; the desktop smoke
test asserts the records are bundled into main. No record in this build carries an
`evidenceId`, so every gate is closed and each surface shows the specific reason
(platform, architecture, custom binary, home mismatch, isolated profile, awaiting
certification). A report supports a record only when every required assertion is `true`,
versions and inventory match, its `sourceCommit` equals the record's `evidenceCommit` and
it is not `dirty`; a unit test re-checks every cited report with `evidenceMismatches`.

Certification has two phases, because stamping a record changes the bundle that embeds
it:

1. **Evidence.** A live harness runs outside F5 on a clean checkout of main and writes a
   report; the stamper validates it and stamps the record, which lands on main by PR.
2. **Acceptance.** The release workflow builds the signed **draft** that embeds the
   stamped record. The operator installs that draft's DMG and runs
   `bun run integrations:accept --integration <i> --tag vX.Y.Z --artifact <dmg>`, which
   hashes the DMG, requires the installed app's cdhash and version to match it, and walks
   the `INTEGRATION_ACCEPTANCE_CHECKS` list: process stops, idle stop, background work
   (fixture hits) and manifest bytes are observed; the rest are confirmed. Its report,
   `docs/computer-certification/acceptance-<version>-<integration>-darwin-<arch>.json`
   (one per architecture's DMG), is committed to
   main. `bun run release:promote --tag vX.Y.Z` then publishes the draft only when, for
   every certifying record in the tag, main holds an all-passed acceptance report for the
   draft's exact DMG digest, the tag's commit and those record IDs, and every
   `evidenceCommit` is in the tag's history. Both scripts read records at the commit the
   remote tag names and refuse a local tag that differs; acceptance also requires
   `codesign --verify --deep --strict` on the installed and the mounted app before
   comparing their CDHash. It is the only supported way to undraft (by policy: a
   maintainer can still run `gh release edit --draft=false`).

On any acceptance failure the draft is not published: withdraw the record
(`--withdraw <id> --reason <note>`), note it in the CHANGELOG and cut a new release.

Codex records hold a **certified floor**: the stamper writes the exercised ChatGPT app,
plugin or service versions as `appMin`, `pluginMin` or `serviceMin` with no `*Max`, so
newer ChatGPT builds stay open (settings note "Certified on ChatGPT <floor>; running
<version>"). Every spawn still re-inspects signatures, extension IDs, origins, the host
name and the helper, then verifies the live tool inventory digest and advertised schemas
against the record; any mismatch closes that session with its specific reason. Floors
can overlap: the installed version picks the record with the highest floor at or below
it (`recordForVersion`), so a newer floor stamped for a changed inventory takes over for
the builds it covers while older builds keep theirs. Acceptance exercises that same
record.

Floors are a deliberate trade-off. Behaviour is re-verified only by a new live run;
newer ChatGPT builds are trusted on their signatures, identity and unchanged inventory
(names and schemas; tool descriptions are not hashed, and F5 shows only the stamped
ones). A behaviour regression behind an unchanged inventory is handled by withdrawing the
record, and **withdrawal is not retroactive**: it reaches users only when they update F5.
Installed F5 builds keep accepting later ChatGPT builds until then.

`bun apps/server/scripts/generate-claude-chrome-descriptor.ts --check` (CI job
`macos-descriptor-drift`) re-extracts the Claude descriptor from the pinned CLI and fails
on drift, comparing parsed JSON so formatting never counts. Writing runs the repository
formatter. Regenerating keeps older records, because journals reference them, and keeps
any withdrawal. `--withdraw <id> --reason <note>` retires any record, including the
current CLI's (the emergency off-switch); `--evidence` refuses a withdrawn record unless
`--reinstate` is passed. `bun run sdk:audit` fails when a
non-withdrawn `claude-chrome` record names an SDK version other than the pin, so support
never disappears silently on an SDK bump.
`COMPUTER_CHROME_APP_IDS` is the union of every record's browser bundle IDs; native
control of those browsers is excluded while a Chrome lease is held, and other apps stay
available.

### Claude in Chrome

Identity is the realpath of the bundled CLI, its platform package version and the
instance home; the 240 MB binary is never hashed. A custom binary or a mismatched home
reports unavailable. Disabled instances do no Chrome I/O, and warm admission reuses
manifests and wrappers cached by metadata fingerprint. Claude launches with `--chrome`
only when the record certifies, the toggle is on and setup is approved; otherwise with
`--no-chrome`, and user overrides of either flag are stripped. Isolated F5 profiles set
`HOME` to the profile's provider home, where the browser's native-messaging folders do
not exist, so Claude in Chrome reports unavailable there with that reason. The session's
restart fingerprint covers only the launch decision and wrapper target, never connection
health, so a disconnect or reconnect does not restart the session.

Admission widens `evaluateAgentBrowserToolPolicy()`. Every call needs the live policy, the
current generation, a verified server and registration, healthy main-owned ownership with
no `recovery-required`, an unchanged wrapper and registration snapshot and a recognized
operation; unknown tools or action variants get `unsupported-operation`. Admission runs
again after approval waits and immediately before launch, within a 1 s budget whose
timeout denies with its own message. Chrome tool IDs and lookalikes
are masked from the first SDK message; DOM text, typed values and raw screenshots stay out
of logs and activity. Startup failure leaves the session running with Chrome `failed`;
reconnecting is explicit and failed actions are never replayed.

Ownership and coexistence: another F5 profile's registration is foreign and needs consent,
reusable only for the same profile, instance, target and exact snapshot. If a terminal
`claude --chrome` rewrites the registration during an F5 session, admission fails with
`external-cli-conflict`; F5 never rewrites it back and never touches the terminal CLI. A
standalone `claude --chrome` therefore reclaims the browser connection. In Full access
Claude skips the extension's per-site permission prompts; the toggle, consent and user
guide disclose this, along with the seven browser folders that get created.

### Main-owned stop

Chrome-enabled CLIs and proxied integration children are spawned in their own process
group and registered with desktop main (`chromeProcessRegister`) before any stdio flows;
a refused registration kills the child. Main accepts a registration only for a group
leader that descends from that backend's own server process, so a server cannot have
main signal an arbitrary group. `ChromeProcessSupervisor` reads `ps` in UTC under the C
locale and guards against PID reuse with the observed start time. On ⌃⌘Esc, profile
disconnect, backend replacement or shutdown, main invalidates the generation
synchronously, sends `SIGTERM` to the group and `SIGKILL` after 1 s (normal shutdown gives
2 s), even when the server is frozen. Exit means the whole group is gone: the lease is
released only once no live member remains (zombies excluded), or the leader's PID now
belongs to a different process. A failed `ps` read, or a row whose IDs are unreadable,
counts as unknown and never as exit; a row with an unreadable start time still counts as a
live member. If no exit is seen within 5 s the holder becomes `recovery-required`,
persisted by desktop main, and new Chrome ownership and conflicting native control are
refused. Main keeps sending `SIGKILL` to a recovery group (start time re-checked each time)
and clears it once the group is gone. Live registrations are persisted too: after a
crash, the next launch treats them as orphans, stops them the same way (`SIGTERM`, then
`SIGKILL`) and blocks Chrome until they are gone. Quitting awaits the shutdown stop, until
every group has exited or been persisted for recovery, within the 6 s cleanup budget.
⌃⌘Esc also stops idle Chrome-enabled sessions; their generation stays invalidated,
refusing new registrations and leases, until the user resumes. Main never signals Chrome,
unrelated native hosts or terminal Claude. Server-side cleanup is an idempotent finalizer that runs even when
event publication or SDK cleanup throws.

### Journal and restore

`chromeNativeHostStorage.ts` writes journal v2 transactions atomically under
`claude-chrome/transactions/`. Before launch it persists identity, record, SDK version,
executable realpath and immutable restoration slots holding each artifact's original
bytes and mode or absence; after launch, the launch snapshot and `postLaunchHash`
per artifact. States are `approved`, `launched`, `restoring`, `partially-restored`,
`restored` and `recovery-required`. `reconcile` fills post-launch hashes on connection,
startup timeout, in the finalizer and at server start.

Listing and restore read storage directly, so history survives restarts, SDK upgrades
and retired records. Restore validates each slot against the transaction's own record
rules, never runs an old wrapper and restores an artifact only when its current bytes
equal `postLaunchHash` or its target equals the transaction's. Each artifact persists a
`restoring` intent, rechecks ownership, writes atomically and persists `restored`;
external changes are skipped and stay retryable. Restoring an older transaction while a
newer unresolved one owns an overlapping artifact is refused with the blocking ID before
anything is stopped. Restore takes a storage-only lease from main
(`chromeRestoreAcquire`) that needs no certification, so a closed or withdrawn gate never
strands written files, but it is still exclusive: if another profile holds Chrome,
restore retries for 5 s, then returns `busy` and writes nothing. Any other refusal is
reported with its reason and "No files were changed." Settings marks **stale** transactions (wrapper
missing or its target gone) with "Restore recommended", and shows legacy v1 journals,
whose unprovable slots are reported as unresolved.

### Codex Chrome: the proxy veto

Codex skips MCP approvals in Full access, so its approvals cannot act as a veto. F5
instead serves the integration itself: Codex sees an HTTP MCP server named `node_repl`
on F5's loopback MCP server (`/mcp/integration`), and `IntegrationProxyCatalog.ts`
lazily spawns ChatGPT.app's `Contents/Resources/cua_node/bin/node_repl` as a registered
child. Every call is admitted in F5's own transport:

- `tools/list` answers from the record's `advertisedTools`, so listing never starts
  `node_repl`; only `js` and `js_reset` are exposed;
- the user consents once per session generation (consent kind `chrome-session`) before
  the child is first spawned; declining never starts it;
- the app, plugin, `node_repl` and helper are inspected again (signatures through a cache
  keyed by the bundle's identity and seal) right before each spawn, which can be hours
  after session start; a change refuses the spawn;
- the paged live inventory hashes to the record's `toolInventorySha256` and its schemas
  match the advertised ones; until then every call is denied, and `tools/list_changed`
  re-lists (without a second `initialize`) and re-verifies;
- a call is tracked from its first await, so a cancel during consent, checks or
  verification stops it before it is forwarded;
- live policy, session generation and pause are checked on every call, and again after
  the lease wait and immediately before forwarding;
- the native-host registrations, the helper link's realpath and the helper binary's file
  fingerprint still match the snapshot taken at session start;
- a Chrome lease is acquired before the first forwarded call and held for the child's
  whole life, because `node_repl` keeps state and code a call started (timers,
  listeners) can outlive it. An idle child is stopped after 60 s, like an idle native
  lease. The proxy releases when the child exits, and main keeps the lease until every
  process in its group is gone, stopping whatever remains.

Pause, interrupts and turning the integration off cancel in-flight calls and stop the
child (`SIGTERM`, then `SIGKILL` after 3 s), so background work stops too. The client's
own `notifications/cancelled` and a 120 s per-call deadline cancel just that call; a
child that doesn't answer within 10 s is killed. Late responses after a generation change
are discarded. Requests the child sends to F5 get "method not found", and an output line
over 16 MB kills the child. Each MCP connection has its own id space, so a late
cancellation from a previous connection never names a live call. Stdio errors on a dead
child's pipes are absorbed rather than crashing the server. The `node_repl` source and
output are fully masked in F5's activity.

Requirements: an isolated effective Codex home (the instance's `homePath`, else an
inherited `CODEX_HOME`, else `~/.codex`, which never qualifies), Full access (`node_repl` runs
unsandboxed JavaScript that an approval UI cannot meaningfully show), an interactive
desktop session (workflow profiles and synthetic threads never get it) and a verified
ChatGPT.app. Inspection is read-only: the app and `node_repl` signatures (team
`2DC432GLL2`), app and plugin versions, `extension-ids.json`, and the native-host
manifests in the record's browser folders with their `latest` helper target. F5 never
reads Codex's `config.toml` or auth and never writes the registrations. A helper whose
version lags the app reports "Open the ChatGPT app once to update its Chrome helper."
Toggling `enableCodexChrome` restarts the session before the next turn.

### Codex Computer Use (Sky)

No `codex-computer` record exists. `inspectCodexComputer` reads nothing without one and
reports "awaiting a live safety certification". The spike
(`integration/codexComputerSpike.live.test.ts`) runs `SkyComputerUseClient mcp`
through the same proxy with a dev-only candidate record and checks launch, enforced and
refused targets, cancellation timing and the inventory; a performed case passes only with
its positive control (`mustContain`) in the observation. It cannot observe a launch from
F5's sandboxed backend or F5's window exclusion, so `launch` and `f5-windows-excluded`
stay false until the packaged-app run. Any failure keeps the gate closed. Backend selection
already requires a certified record, `auto`, Full access and an installed client;
otherwise F5's native control is used. Desktop main refuses the built-in's foreground
lease while `codex-computer` is uncertified.

### Side effects and live checks

Claude in Chrome creates or rewrites the Claude native-host manifest in each of the
record's browser folders and a wrapper in the instance home; restore puts the original
bytes back. Codex integrations change nothing on disk.

Live checks run from Terminal outside F5 and refuse `F5_AGENT_PROCESS=1`. An F5 agent
sandbox cannot run them: `sandbox-exec` inside the already-sandboxed backend exits 71,
and the browser folders are unreachable. Each writes a scrubbed report (no credentials,
DOM text or screenshots) for the operator gate and never stamps a record:

- `F5_CLAUDE_CHROME_LIVE=1 bun run --cwd apps/server test:file integration/claudeChromeNative.live.test.ts`
  with `CLAUDE_CONFIG_DIR` set to an authenticated isolated config and
  `F5_CLAUDE_CHROME_REPORT=<file>`;
- `F5_CODEX_NATIVE_LIVE=chrome … integration/codexChromeNative.live.test.ts` with
  `F5_CODEX_CHROME_REPORT=<file>`;
- `F5_CODEX_NATIVE_LIVE=computer … integration/codexComputerSpike.live.test.ts` with
  `F5_CODEX_COMPUTER_SPIKE=<spike file>` and `F5_CODEX_COMPUTER_REPORT=<file>`.

The certification runner (`scripts/computer-certification`) wraps these as its manual
`chrome` and `builtin` scenarios. Each report records `sourceCommit` and `dirty` from the
checkout (keep spike files outside it). `generate-claude-chrome-descriptor.ts --evidence`
(Claude) and `bun run integrations:stamp --integration codex-chrome|codex-computer
--evidence <report>` (Codex; `--template <spike file>` for Sky's first record) validate a
report against its record before stamping; the Codex stamper also takes `--withdraw`,
`--reinstate` and `--check`. Every assertion is computed from an observation. The Codex
Chrome harness reports every tool's schema (the allowed ones become `advertisedTools`)
and proves `background-work-stops-on-pause`: a `js` call leaves a timer navigating a tab
to a loopback fixture, the session is paused, and the fixture must go quiet within 2 s
and stay quiet for 5 s. The Claude harness records manifest and `connected` timings,
compares the origins it reads back and the bytes of two real launches, and lists the
assertions it cannot yet observe (permission mode, routing isolation, stale native host,
terminal coexistence, frozen-server stop) under `notAutomated`. Those stay `false`, so
its report cannot certify until they are automated; never edit a report by hand.
`bun apps/server/scripts/probe-computer-builtins.ts` prints read-only availability.

## Observation lifetime and turn ownership

Observation invalidation preserves in-flight invocation admission, so a retry with the
same ID joins the original result and cannot repeat input. Action invalidation also
preserves granted app-name resolutions. Connection replacement and session disposal
still invalidate invocation admission. Actions without a screenshot discard coordinate
evidence; capture again before using coordinates.

The active lifecycle turn is pinned before context lookup. Turn revisions reject stale
context and lease completions, and each binding stores only its latest ended turn.
Expired consent stops raising attention and leaves the pending dialog; its request is
retained until authoritative settlement or connection replacement. Remote clients still
receive attention because approval must be completed on the host desktop.

## Certification and validation

Certification records, validation runs and remaining release work live in [reviews/agent-browser-validation.md](reviews/agent-browser-validation.md).

The [computer-control follow-up verification](computer-certification/2026-10-18-computer-followups-verification.md) and [review corrections](computer-certification/2026-10-18-review-followups.md) record the current probe results and remaining certification prerequisites.
