# Phase 10: composer state drawers and scroll collapse

The composer uses the authenticated `composer-redesign` bootstrap capability.
Without it, the client retains the expanded composer and the task panel in the
timeline. The server advertises the capability in `wsServer/protocol.ts` only
when launched with `F5_COMPOSER_REDESIGN=1`. It is **off by default** because the
plan prohibits advertising features before their release gates pass. This opt-in
allows evaluation of the implemented UI while the existing program-wide
performance failures remain unresolved.
No wire union or persisted server state changes, so protocol version 12 remains
compatible. Existing queue items, questions, attachments and rewind drafts remain
readable regardless of the capability.

## Behavior

- Tasks, worktree setup, queued turns, asynchronous questions, answer attachments
  and rewind drafts are attached to the composer in a bounded, scrollable dock.
  The dock occupies normal document flow, so it cannot cover conversation text.
  Blocking approval/question and plan controls remain attached to the editor.
  Command suggestions attach immediately above the editor.
- The web-local `composerCollapseOnScroll` setting defaults to true. It is exposed
  in General settings and settings search. It is persisted through `appSettings.ts`,
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
  contents, relocating controls, or animating height.
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
performance release failures remain open and an implementation commit is still
needed to record `f5Shas`. The plan permits commits only when requested;
no uncommitted change is attributed to an unrelated existing commit. The original
September classification file remains a historical planning artifact.

## Validation

Full-app browser tests run with the capability enabled and cover:

- Collapse/expansion with an existing draft and selected text, asserting the exact
  editor DOM identity and historical reading anchor remain stable.
- Blur, window refocus, active scroll momentum, IME, and a model menu kept open across transitions.
- Capability and user-setting fallback.
- Switching from a collapsed conversation to a separate draft without losing text.
- End pinning through collapse and expansion.
- Long task lists in a short viewport, including bounded dock/body heights and a keyboard-focusable task body.
- Nested output panes, pinch zoom, timeline selections, gesture thresholds, and empty conversations.

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

Passed on the final implementation:

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
has been relaxed, and **full phase sign-off remains open**; the default capability
is therefore kept off. The full report is not represented as a green release gate.

Raw artifacts (ignored, machine-specific):

- `.performance/phase10-before-valid.json`
- `.performance/phase10-after-valid.json`

Reproduce the comparison with:

```sh
bun run perf:compare .performance/phase10-before-valid.json .performance/phase10-after-valid.json
```

To evaluate the implemented composer in a development session:

```sh
F5_COMPOSER_REDESIGN=1 bun run dev
```

Restart the server when changing this flag, then reload the client so it receives
the new authenticated bootstrap. The local scroll-collapse preference remains
available in General settings; disabling it keeps the attached drawers while
leaving the editor expanded.
