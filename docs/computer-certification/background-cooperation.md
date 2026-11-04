# Background cooperation acceptance

Computer cooperation spans the helper, desktop main, and backend. Capabilities enable
yielding only when every layer supports it; older peers keep their pause behavior.
Foreground and takeover control remain exclusive across the desktop.

## Current acceptance status

The implementation has controller, broker, contract, UI, and native policy tests.
Those tests do not establish real input delivery or application compatibility.
The production `BACKGROUND_EVENT_APPS` lists in
`packages/shared/src/computerApps.ts` are empty on both platforms.

During implementation, the macOS TextEdit rehearsal stopped with
`helper-other-instance` before input. Windows delivery was cross-compiled and
portable tests ran, but no interactive Windows rehearsal was available. The full
Swift suite also has two keyboard-event tests that require `CGEvent` creation;
in that session creation returned nil. Do not infer certification from a successful
build, protocol handshake, policy test, or fixture response.

Existing recorded certification JSON remains unchanged. Save new evidence to a new
report path; the rehearsal refuses to overwrite an existing report.

## Rehearsing background events

Use an unlocked test desktop and a debug helper. No other helper may be active.
If startup reports `other-instance`, leave that helper untouched and use a
separate test session. Never bypass the single-helper lock.

Prepare a disposable, scrollable document in the candidate app. Put the caret in
its text field near existing text, then switch to another app. The runner sends
`Shift+Left`, a single `x`, and an element scroll. It does not send Enter,
launch apps, move the pointer, or restore focus.

On macOS:

```sh
cd apps/desktop/native/macos
swift build --disable-sandbox
cd ../../../..
F5_COMPUTER_BACKGROUND_EVENTS_REHEARSAL=1 bun apps/desktop/src/computer/rehearseBackgroundEvents.ts \
  --helper apps/desktop/native/macos/.build/debug/f5-computer-helper \
  --app com.apple.TextEdit \
  --output /tmp/textedit-background-events.json
```

On Windows, build the debug helper with `cargo build` in
`apps/desktop/native/windows`, prepare the same disposable document, then run:

```powershell
$env:F5_COMPUTER_BACKGROUND_EVENTS_REHEARSAL = "1"
bun apps/desktop/src/computer/rehearseBackgroundEvents.ts `
  --helper apps/desktop/native/windows/target/debug/f5-computer-helper.exe `
  --app notepad.exe `
  --output "$env:TEMP/notepad-background-events.json"
```

The standalone runner supplies a debug-only helper flag for one of the centralized
`BACKGROUND_EVENT_CANDIDATES`. Desktop main never supplies it and release helpers
ignore it. This allows testing candidates without enabling them in production.

| Platform | Candidates                               |
| -------- | ---------------------------------------- |
| macOS    | TextEdit, Notes, Finder, Terminal, Xcode |
| Windows  | Notepad, Explorer, Windows Terminal      |

Each app must show an accessibility value, selection, or scroll-position change for
all three actions. `verification.verified: false` is a failed certification check,
even when event posting succeeded. The report contains booleans, failure codes,
platform/version, and helper/source hashes, not screenshots or document text.

Also measure cursor preservation, foreground switching, monitor failure, physical
interruption latency, and held-key/button behavior on the real desktop. Only add an
app to `BACKGROUND_EVENT_APPS` after this evidence passes and is reviewed.
Then run `bun scripts/generate-computer-tiers.ts` and its `--check` mode to
update and verify the native tables. Never promote the candidate list wholesale.

## Cooperative execution checks

Use a macOS development build with `F5_COMPUTER_CONTROL_DEV` and
`F5_COMPUTER_BACKGROUND_DEV`, or the corresponding interactive Windows build.

1. Interact with an agent's background app. Its state becomes **Waiting for you to
   finish**, queued mutations return `TargetBlocked user-active`, and consent
   stays pending. Leave the app; the agent waits and inspects again before writing.
2. Continuously scroll a non-frontmost target. Continuation stays blocked until
   scrolling stops. Brief re-entry resets eligibility; typing in another app does not.
3. In Full access foreground control, move the pointer or type. Input stops at once,
   the overlay waits, then counts down after three idle seconds. Held keys/buttons
   block continuation, and coordinate actions require a new screenshot. In a normal
   thread, the same input latches Pause and Resume asks for native confirmation.
4. Contend for leases and takeover reservations across profiles. Conflicting arrivals
   cannot jump earlier waiters. Busy/canceled reservations show no native consent.
5. Share one app between agents. A press followed by another agent's write makes
   subsequent typing fail `shared-focus` until a fresh press. Stale snapshots
   require inspection. Canceled or uncertain work excludes the app until confirmed drain.
6. Revoke saved app/session/takeover consent mid-action and while a dialog or waiter
   is pending. Authority is removed immediately, including when disk deletion fails.
7. Pause, Stop, or use the stop shortcut with active and yielded agents. All latch;
   helper restart, monitor failure, input overflow, unresolved ownership, permit
   expiry and activation incidents must also latch. No unknown mutation is replayed.

## Repository verification

Run `bun fmt`, `bun lint`, `bun typecheck`, `bun run test:full`, and
`bun run upstream-ports:check`. Run `swift test --disable-sandbox` in the
macOS helper, `cargo test` on Windows, and the relevant browser component tests.
Keep fixture evidence distinct from native desktop acceptance.
