# Phase 10: composer state drawers and scroll collapse

The composer uses the authenticated `composer-redesign` bootstrap capability.
Without it, the client keeps the expanded composer. The server advertises the
capability in `wsServer/protocol.ts` **by default**; launching it with
`F5_COMPOSER_REDESIGN=0` omits the capability and restores the legacy layout.

The redesign was first shipped opt-in because the plan prohibits advertising
features before their release gates pass. It was enabled by default on 2026-10-08
after a product decision: the two gates still open (below) fail identically on the
build without the redesign, and the redesign improved the heap-growth ratio, so they
are program-wide failures rather than regressions from this phase. They remain open
and are tracked as such.
No wire union or persisted server state changes, so protocol version 12 remains
compatible. Existing queue items, questions, attachments and rewind drafts remain
readable regardless of the capability.

## Behavior

- Tasks, worktree setup, queued turns, asynchronous questions, answer attachments
  and rewind drafts are attached to the composer in a bounded, scrollable dock.
  The dock occupies normal document flow, so it cannot cover conversation text.
  The complete composer stack is capped at 55% of the chat column remaining
  above the terminal, with scrolling for a long draft plus drawers.
  Blocking approval/question and plan controls remain attached to the editor.
  Command suggestions sit above the editor in normal flow inside the bounded input stack.
- The web-local `composerCollapseOnScroll` setting defaults to true. It is exposed
  in General settings and settings search only when the capability is available. It is persisted through `appSettings.ts`,
  without adding a server setting or a client/server routing allowlist.
- An existing thread can collapse after 24 pixels of timeline wheel input. The
  gesture resets after 120 ms of inactivity. A non-overflowing timeline, scrolling
  beyond an edge, horizontal input, pinch zoom, a nested output pane, an open
  popup, timeline text selection or IME composition cannot trigger collapse.
- Blur never collapses the composer. Returning to the application does not expand
  a resting composer. Editor pointer/keyboard input, paste and composition expand
  it and suppress the active gesture's remaining momentum. Changing threads resets
  resting state. Blocking input and setup attention keep the editor expanded.
- Collapse changes CSS on the same editor and toolbar. Lexical's document,
  selection and undo history remain mounted. Attachments have a compact count
  button while resting; expansion restores the original tray. The toolbar keeps
  its existing responsive form-width breakpoints, without measuring its own child
  contents or relocating controls. The editor height, its padding and the
  attachment tray change through a short CSS transition (instant under reduced
  motion or without `calc-size()`). The editor animates toward its 200px cap,
  and its content and the tray stay clipped while it moves. The dock re-pins a
  timeline at its end on every animated frame.
- Queue next/end, Send now, pause/resume, steering, Plan mode, workflow actions,
  model fan-out, runtime/effort controls and display-profile presentation continue
  to use their existing components and dispatch paths. Auxiliary state panels
  retain their own focus handling instead of inheriting the prompt editor's
  popup-focus policy.

## Upstream mapping

The primary references are `792a1404f` (state drawers), `5b8445b7a` (resting
composer), `044ea8e34` (layout stability), and `a12589dc0` (final scroll-only
behavior). All 30 ledger entries assigned to workstream 10 have individual
implementation reasons and file evidence. F5 retains its own activity timeline,
Lexical editor, fixed-width responsive controls and normal-flow layout; intermediate
upstream banner rewrites/reverts, Tiptap changes and environment controls are not
copied into unrelated F5 subsystems.

The ledger deliberately retains `deferred` delivery status while the existing
performance release failures remain open. All 30 entries record implementation
commit `0640ab8e001cebf7dc8ca7b15b9e0ffc8f9d97b4` in `f5Shas`. The original
September classification file remains a historical planning artifact.

## Validation

The existing full-app tests use the default, capability-off layout. The composer
redesign describe block opts in explicitly and covers:

- Collapse/expansion with an existing draft and selected text, asserting the exact
  editor DOM identity and historical reading anchor remain stable.
- Blur, window refocus, active scroll momentum, IME, and a model menu kept open across transitions.
- Capability and user-setting fallback.
- Switching from a collapsed conversation to a separate draft without losing text.
- End pinning through collapse and expansion.
- Long task lists in a short viewport, including bounded dock/body heights and a keyboard-focusable task body.
- Nested output panes, pinch zoom, timeline selections, gesture thresholds, and empty conversations.
- History removal without viewport resizing, attachment errors during collapse,
  accessible attachment expansion, and bootstrap capability arrival.
- Long tasks plus a tall draft and an open terminal in a short viewport.

The existing Phase 3 browser tests also run: send/stop, draft routing, image/file
insertion, queue actions, IME, Plan/workflow actions, provider controls, and
responsive layout. The production performance fixture advertises the new
capability so candidate measurements exercise the redesign rather than its
fallback. Baseline and candidate use the same deterministic fixture and harness.

The fixture also answers the existing Phase 8 rewind-draft read and Phase 9 setup
subscription. Before this repair, both were reported as unknown RPCs; those
aborted runs are not validation evidence. Neither reply adds work to the fixture
(an empty draft list and no setup snapshot).

The baseline web bundle was built from `bfb7871cd9` before editing production
source. The candidate is built from this working tree. Both full runs use the
same repaired fixture, runtime and browser, with five warmups, 30 repetitions and
a ten-minute soak. The shortened soak and final-five-minute memory window follow
`docs/performance.md`.

Passed on the initial implementation (review follow-up results below):

- `bun fmt`
- `bun lint` (existing warnings, no errors)
- `bun typecheck`
- `bun run test:full`, including all 133 exhaustive real-Git cases
- `bun run --cwd apps/web test:browser`: 541 tests across 56 files
- `F5_REQUIRE_UPSTREAM=1 bun run upstream-ports:check`
- `bun run --cwd apps/web build`, including the initial-bundle budget

Initial web JavaScript is 1,332,279 bytes, compared with 1,331,836 before the
change (+443 bytes). The larger composer module remains a route-loaded chunk.
The collapsed layout and the fully opened task drawer were also inspected in
Chromium screenshots.

| Measurement                     | Before p95 | Candidate p95 | Gate                                       |
| ------------------------------- | ---------- | ------------- | ------------------------------------------ |
| Composer input-to-paint         | 17.1 ms    | 18.6 ms       | ≤ 100 ms                                   |
| Composer input while streaming  | 16.0 ms    | 17.6 ms       | ≤ 100 ms                                   |
| Warm switch to the large thread | 193.9 ms   | 193.1 ms      | ≤ 500 ms                                   |
| Small-thread startup            | 154.6 ms   | 158.0 ms      | No regression exceeding both 10% and 20 ms |

The fixture and harness digests match between the two full runs. `perf:compare`
reports only the same two bounds that already failed on the unchanged build:

| Remaining gate                                   | Before          | Candidate       | Limit         |
| ------------------------------------------------ | --------------- | --------------- | ------------- |
| Pending transport frames                         | 4,148           | 4,148           | 2,000         |
| Browser retained heap growth, final five minutes | 9.2% (4.73 MiB) | 7.0% (3.67 MiB) | 5% and 10 MiB |

Both absolute heap-growth checks pass; the ratio fails. Server and combined heap
limits, transport byte/queue limits, native terminal history limits and all latency
limits pass. No new failed bound or gated latency regression was observed. These
two failures were also documented in the Phase 7 validation report. No threshold
has been relaxed, and **full phase sign-off remains open**. The capability was
originally kept off for that reason; it is now on by default (see the top of this
report). The full report is not represented as a green release gate.

Raw artifacts (ignored, machine-specific):

- `.performance/phase10-before-valid.json`
- `.performance/phase10-after-valid.json`

Reproduce the comparison with:

```sh
bun run perf:compare .performance/phase10-before-valid.json .performance/phase10-after-valid.json
```

To compare against the legacy composer in a development session:

```sh
F5_COMPOSER_REDESIGN=0 bun run dev
```

Restart the server when changing this flag, then reload the client so it receives
the new authenticated bootstrap. The local scroll-collapse preference remains
available in General settings; disabling it keeps the attached drawers while
leaving the editor expanded.

## PR review follow-up

Implementation commit: `cffeb4004468ba2efd952ea288a2ef24ba653c17` (also recorded in the ledger).

State panels again render from ChatView, preserving their full-width legacy
placement without the capability. The shared task toggle removes duplicated state
updates. Closed task bodies remain inert in both layouts, an intentional
accessibility improvement that prevents focus entering visually hidden content.

The collapsed wheel path now skips layout, popup and style queries while tracking
momentum. A resize/content observer also follows late-mounted timelines and history
removal. Blocking an already-expanded editor does not suppress an unrelated gesture.
Attachment validation errors prevent collapse; the count control uses singular/plural
labels and ARIA state/control references, and the form names its collapsed state.
The screenshot environment hooks were removed from committed tests.

The performance measurements above apply to the original implementation commit,
not the review follow-up. The redesign remains opt-in and the existing performance
release gates remain open; the follow-up does not claim a fresh full performance sign-off.

Review validation: `bun fmt`, `bun lint` (13 existing warnings, no errors),
`bun typecheck`, the production web build/bundle budget, and all 546 browser
tests across 57 files pass. All 102 ChatView tests passed again after the final
observer cleanup. The initial full browser run hit a transient failure in the
unchanged workflow drag test; the complete rerun passed without changing that test.

`bun run test:full` also passes, including all 133 exhaustive real-Git cases,
as does `F5_REQUIRE_UPSTREAM=1 bun run upstream-ports:check`. The first workspace
run hit timeouts in unchanged ledger tests while browser/build jobs were running;
the isolated full rerun passed without changing timeouts or those tests.
