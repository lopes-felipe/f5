# Windows computer preview acceptance

The Windows helper implements scoped foreground/background execution, UI Automation
inspection and semantic actions, per-window capture, password masking and emergency
stop. The target is Windows x64, build 19041 or newer. Packaged foreground and
background previews are available after the native workflow,
lifecycle and capture privacy checks passed on an interactive Windows 11 machine.
Computer use defaults to enabled with background execution. Saved preferences are
preserved, and each app still requires approval.
Signed installed certification remains false; additional acceptance is pending.
Cross-compilation and unit tests cannot substitute for that evidence.

## Running acceptance

Use an unelevated, attended Windows 10 or Windows 11 desktop with Node, Bun,
Rust/MSVC and the Windows SDK. Close other F5 instances: the helper owns a
per-session device mutex. Provider phases also need Claude/Codex executables and
authenticated test profile homes. Use a clean checkout and a new output directory.

```powershell
bun install --frozen-lockfile
bun scripts/computer-certification.ts prepare --output C:\F5Checks\run-1 --platform win32 --arch x64 --provider both --claude-home C:\F5Checks\claude --claude-binary C:\Tools\claude.exe --codex-home C:\F5Checks\codex --codex-binary C:\Tools\codex.exe
bun scripts/computer-certification.ts run --output C:\F5Checks\run-1 --group workflows --scenario windows-helper --operator-ready
bun scripts/computer-certification.ts run --output C:\F5Checks\run-1 --group workflows --scenario fixture-workflow.codex --operator-ready
bun scripts/computer-certification.ts run --output C:\F5Checks\run-1 --group recovery --scenario main-stop.codex --operator-ready
bun scripts/computer-certification.ts report --output C:\F5Checks\run-1
```

Omit provider arguments for native-only checks. Preparation sends no grants or
input. Approve only named synthetic apps, keep input idle during actions, and
follow the fixture prompts. Windows emergency stop is Ctrl+Alt+Shift+F12.
The suspended readiness probe waits at most five seconds for initial monitor
checks to finish. It accepts only a healthy helper status; persistent monitor
failure remains unavailable, and other unavailable statuses stop it immediately.
It sends only a status request and never grants execution authority.
Physical-stop drivers suspend the actual Electron main/renderer process with an
independent supervisor that resumes it on timeout or stdin EOF. Helper and fixture
timings share Windows uptime and the existing 100 ms stop evaluator.
The freeze supervisor confirms positive native suspend counts for every thread
using read-only ThreadSuspendCount queries. It retains thread handles until a
second enumeration verifies the thread set, and rejects failed queries, zero
counts, empty sets, timeouts or automatic resume. Thread queries do not hold the
independent resume timer's lock. Scheduler wait-reason labels are not used as
suspension proof. Capture reports include bounded freeze counts and timings.

## Local PowerShell entry point

No remote connection or GitHub runner is needed. In a clean checkout containing
these changes, open a regular PowerShell window and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-windows-computer-acceptance.ps1 -Phase native
```

The execution-policy override applies only to this PowerShell process. The script
checks the actual session, elevation and Windows build; installs locked workspace
dependencies; builds the exact helper, desktop and fixtures; and prints its new
evidence directory. It does not install system prerequisites or change release
gates. Use Node 24.13.1+, Bun 1.3.9+, Rust's x64 MSVC toolchain, Visual Studio
Build Tools with Desktop development with C++ and a Windows SDK. The native phase
does not need provider credentials.

If transferring the prepared source bundle, use Git to clone the bundle into a
new Windows directory first, then run the command above from that checkout.
The bundle is a clean source snapshot for acceptance, not an installer or a
certified build. Existing installed Windows F5 preview gates remain unchanged.

Repeat with the lifecycle and privacy phases. The displays phase requires two
displays with different DPI and a negative origin, and asks you to rotate a
display and change its arrangement/resolution in Windows Settings. It observes
the changes independently; it does not alter display settings itself. Restore
your preferred arrangement after the check.

Provider runs need explicit authenticated test-home and executable paths:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-windows-computer-acceptance.ps1 -Phase provider-workflows -Provider codex -CodexHome C:\F5Checks\codex -CodexBinary C:\Tools\codex.exe
```

Run profiles with Codex and physical-stop for each provider. Stop phases suspend
actual owned Electron main, renderer and broker backend processes. Keep the
session attended and follow the red fixture cue. The quality phase runs the
repository checks and native tests on Windows. Every phase uses a new suite.
Share only manifest.json, _.result.json and _.raw.json; launch.json and provider
homes remain private.

The manually dispatched **Windows computer acceptance** workflow uses an attended
runner labeled `f5-computer-interactive` and `windows-10` or `windows-11`.
Select the runner OS when dispatching and repeat acceptance on both. Configure the repository variables
`F5_WINDOWS_CLAUDE_HOME`, `F5_WINDOWS_CLAUDE_BINARY`, `F5_WINDOWS_CODEX_HOME` and
`F5_WINDOWS_CODEX_BINARY` to paths on that runner. Credentials remain in its test
profile homes. Run native, provider and physical-stop phases separately. Failed
or interrupted input is never retried automatically.

## Evidence boundaries

If a native workflow fails before its first check, the inspection-only diagnostic
can reuse the prepared Windows binaries without rebuilding or editing the checkout:

```powershell
bun apps/desktop/src/computer/rehearsalWindowsDiagnostics.ts --checkout C:\F5Checks\f5 --suite C:\F5Checks\run-1
```

It checks the helper hash against the suite manifest, starts only synthetic
fixtures, and reports the startup/handshake/inspection stage, fixed error tags,
helper availability and accessibility counts. It sends no permits, resume,
capture or input requests. Its result is diagnostic information, not acceptance
or certification evidence.

If the helper has changed since the suite was prepared, the diagnostic stops and
reports the suite, selected and current hashes. To inspect a different binary,
pass its exact SHA-256 as `--helper-sha256` (or `-HelperSha256` in the PowerShell
wrapper). This selection applies only to the inspection diagnostic; the suite
manifest and acceptance rules remain unchanged. The report marks the identity
change and verifies the helper hash again after inspection. Acceptance of a
changed binary requires a new suite.

For a workflow that fails after inspection, the diagnostic wrapper also accepts
`-Workflow`. This runs a fresh synthetic native workflow once, including
input and scoped capture, without rebuilding or editing the checkout. The
standalone handoff includes a bundled `Diagnose-WindowsWorkflow.mjs`; it uses
the selected existing helper and prepared fixtures. It records each operation,
whether the helper returned an error or confirmed the action, elapsed time,
monitor status and independent fixture receipt counts. It never saves inspected
text, screenshots or raw request/response payloads in the diagnostic report.
The result is marked diagnostic-only and has no certification admission ID.

The monitor diagnostic handoff builds just the helper from its hashed source
snapshot in a new temporary directory. Run `Start-WindowsMonitorCheck.ps1`
with `-SuiteDirectory` pointing to a prepared suite. It reuses that suite's
synthetic fixtures and records the new helper identity separately. The original
checkout, helper and suite are unchanged. The workflow observes hook health for
eight seconds after the last action.

Windows mouse monitoring uses a dedicated message-only raw-input receiver with
`RIDEV_INPUTSINK`. Windows supports receiving this input while the helper is
in the [background](https://learn.microsoft.com/en-us/windows/win32/inputdev/about-raw-input).
The helper verifies the process's registration and challenges the receiver
thread before becoming available, then repeats the checks while idle and active.
The diagnostic records `mouseProbe: "raw-input-liveness"` and
`mouseRegistered`. No synthetic mouse event is needed for this check.
The keyboard hook still must acknowledge a tagged keyboard probe. Failed
registration, an unresponsive receiver or an unacknowledged keyboard probe
suspends all scopes. Recovery leaves work suspended.

The raw-input receiver shares recipient/conflict handling with the auxiliary
low-level mouse hook. It ignores helper-tagged events and empty packets,
distinguishes movement from button/wheel activity, and uses bounded stack
storage. Its registration does not request focus, suppress legacy input or
take over another app's mouse handling. Physical mouse interruption and emergency
stop still require interactive Windows acceptance; successful registration and
liveness checks alone are not evidence of physical interruption latency.

Inspection recognizes windows-rs's successful null-interface result (an empty
error with HRESULT 0) as the end of a branch. Actual provider errors mark a
traversal partial while preserving other sibling branches. Time, node and depth
limits still apply. Diagnostic reports retain only traversal counts and bounded
HRESULT codes; partial traversal remains conservative for password masking.
Synthetic fixture readiness may repeat read-only inspection up to six times
before any input. Mutations and native errors are never automatically retried.

The native workflow row covers inspection/subtrees, snapshot and grant isolation, Unicode
and semantic press receipts, masking metadata, background semantic actions,
rejection of global input in background, selective pause and process cleanup.
It does not prove capture pixel privacy or provider consent.

The privacy row uses a separate fixture executable to decode JPEG/PNG in memory
and verify approved/unapproved marker controls, password-field pixels in both
masking modes, zoom alignment, scoped capture, host/overlay exclusion and grant
revocation. A suspended fixture tests refusal of queued/in-flight captures after
their execution generation is retired. Fixture-owned native geometry is independent of helper inspection.
No captures or editable/password text are written to its report.
Revoked app-scoped screenshots are checked with and without an explicit display;
zoom is checked with its required display. Explicit app authorization precedes
display selection and surface enumeration. Refusal mismatches retain the expected
tag and sanitized actual error facts, without tool payloads or screenshots.

The lifecycle row checks permit-expiry latching, retired generations, revoked
and changed grants, replaced UIA elements, queue saturation/drain and loss of
grants/permits/references on helper restart. It does not prove held-input release,
native monitor failure, lock/unlock or RDP transitions.

The displays row requires independently observed topology and fixture DPI on
each display, negative origins, two DPI values, fullscreen capture and overlay
exclusion. Operator-driven rotation and reconfiguration must produce actual
stable native changes before those checks pass. Single-display runs cannot pass.

The Electron drivers cover Claude/Codex discovery, native and Chromium fixture
workflows, remembered grants, session-action consent, profile isolation, and
main/renderer/backend stop. The Windows background row separately requires a
genuine session-control approval, two correlated background semantic actions,
independent Unicode/press receipts, app-scoped capture and unchanged foreground
window identity.
They observe real compiled F5 processes and require genuine human consent.
Development evidence remains distinct from signed installed evidence.

## Rollout record

On 2026-11-02, source snapshot
`9f47709197336042f8ebe2342ba2fbcdea7422da` passed `windows-helper`,
`windows-lifecycle` and `capture` in an interactive Windows 11 session
(build 26340). Suite ID directory:
`f5-windows-acceptance-v2-4f7304c2e069474fb86261468732c7ca`.
This is native development evidence, including independent fixture receipts and
capture pixel privacy checks, rather than signed installed certification.

The subsequent provider run authenticated Claude but stopped at read-only
discovery with `usage-limit`. It did not reach Codex or prove provider workflows.
The release owner chose to ship the preview enabled by default with background
execution and these limits documented. Saved preferences remain in effect.
Preview availability does not mark pending acceptance scenarios as passed.

Retain Windows 10 and Windows 11 evidence for the remaining acceptance cases:

- Real Notepad/Calculator and packaged-app/AUMID workflows; background typing,
  app-local takeover, and concurrent threads/profiles.
- Stale capture refusal under display/window changes during capture.
- Mixed DPI, negative origins, rotation/reconfiguration, fullscreen, moving and
  overlapping windows, transparent/shaped/cloaked and elevated recipients.
- Helper/backend crash and reconnect, expired permits, cancellation, saturation,
  lock/unlock, RDP transitions and held-input release.
- Successful physical-stop evidence during main/renderer/backend suspension.
- Fresh NSIS installation/upgrade, helper confinement and signed-artifact checks.

`COMPUTER_CONTROL_PREVIEW.win32` and `COMPUTER_BACKGROUND_PREVIEW.win32` are
enabled independently of certification. Keep `COMPUTER_CONTROL_CERTIFIED.win32`
false until signed installed certification is complete. Acceptance commands do
not change these gates or turn partial evidence into a certification claim.
Existing development overrides apply only to unpackaged apps.

Windows approvals govern F5's computer tools. Arbitrary agent code retains its
own Windows permissions; the macOS subprocess GUI sandbox is deferred.
Provider-native Chrome integrations and other provider gates remain separate.
