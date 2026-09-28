# Phase 3: composer and workspace UX

Based on merged main `6062486467` (PR #43). The behavior-preserving composer
extraction is commit `87855f3465`; the subsequent changes cover Phase 3b–f and the
previously requested background cloning and per-thread panel widths.

## Behavior and compatibility

- Composer layout and editor state live in `components/chat/composer`. Dispatch,
  durable queue admission, Plan mode, workflows and provider selection retain f5's
  existing implementation. This is not the Phase 10 composer redesign.
- Shortcut commands cover stopping, pinning and copying a thread reference,
  history navigation, page scrolling, background thread creation, closing panel
  tabs, composer controls, provider switching and PR-number copying. Browser
  reserved defaults are Electron-only; web users can bind these commands.
- Archive, snooze and unpin have an eight-second undo toast, with a ten-entry
  per-window stack. Undo does not capture text-editor undo.
- Send behavior is configurable. Prompt history excludes f5's appended context.
  The existing Lexical editor supports plain text or Markdown styling while
  preserving source bytes and mention spelling. New users get styling; existing
  stored preferences retain plain text. Window and option-menu focus restoration
  respect other inputs. Workspace drops and collapsible questions reuse existing
  attachment and answer handling.
- Palette search includes thread IDs, exact-title ranking, PR and Usage actions,
  settings shortcuts and theme selection. Message search already existed. Minimal
  durable PR-link metadata was brought forward to make linked-PR search work;
  accounts, forge actions and the rest of Phase 12 remain separate.
- Migration 092 adds a PR-link search table. A separate projector cursor rebuilds
  links from thread creation/metadata events; it does not rely on an ephemeral UI
  cache. Search matches repository, number, title and URL and excludes deleted
  threads. Existing links that were never persisted cannot be reconstructed.
- Timeline improvements include dated timestamps, hour durations, a 50-thread
  reading-position LRU, minimap navigation, tool timestamps/disclosure controls,
  accessible message headings and middle-truncated labels. Image viewing supports
  zoom, pan and arrow-key gallery navigation. Generic video attachments remain
  Phase 7 work.
- Diff and PR views share file-tree navigation and persisted ordering/collapsed
  folders. Diff defaults and colors are configurable. Large trees load
  progressively, PR totals remain visible, and patches request rename detection.
  Copy-path/context actions and expand/collapse controls are available.
- Workspace folder reads are lazy, bounded and reject path/symlink escapes. The
  ignored-files toggle does not replace indexed search. Folder links reveal the
  corresponding tree location. File saves and highlights are scoped to each visit,
  including A→B→A navigation, and retain content-hash conflict checks.
- Sidebar bulk actions isolate failures. Project icons support automatic initials
  and explicit tinted monograms. Keyboard project context menus, IME-safe rename
  and existing unsent-draft indicators are retained. Error pages copy full reports.
- Terminal close confirms running work and waits for the server. Selection copy,
  insert-key paste, right-click paste and Linux primary-selection paste share
  clipboard handling. Windows shutdown uses the existing process-tree helper.
  Hidden-terminal rendering suspension already existed.
- Model visibility supports bulk toggles. PR authors link to their host's profile.
  Merge selection honors the current choice, configured global default, last
  repository choice, then squash, restricted to methods that the repository allows.
- Background cloning is server-owned: two running jobs, at most ten queued/running
  jobs, idempotent admission IDs and a bounded persisted history. Cancelling or
  restarting preserves partial files and reports the outcome. Existing folders
  are refused. Clones become projects only after success. Cloning never starts
  automatically and never removes a destination.
- Right-panel widths persist for at most 50 threads, with the old global value as
  fallback. File-tree preferences retain at most 50 scopes and last-used merge
  methods at most 100 repositories.

Protocol version increases from 4 to 5 for new commands, RPCs and project icon
variants. Existing open clients must reload through the version gate. New RPCs
use the existing authenticated connection; Linux selection clipboard IPC keeps
main-frame ownership checks. No permission or autonomous-provider defaults change.

The server settings subscription is acquired before provider hydration, closing a
race where an immediate settings change could be missed before the watcher starts.

## Upstream audit

All 193 September-plan records assigned to Phase 3 were inspected: 98 ports,
53 existing f5 equivalents, and 42 fixes for excluded or absent upstream UI
subsystems. Each record carries an individual reason and file evidence in the
single ledger. The original September classification artifact is unchanged.
The plan cited `68607c5a9` under Markdown; its actual upstream change is nested
scroll handling, and the implementation and ledger follow the actual commit.

## Validation

- Formatting, lint and typecheck were run. Lint has existing warnings but no errors.
- The full suite passed: 1,694 web unit tests, 2,651 server unit tests (nine skipped),
  the remaining workspace suites, eight regular Git integration tests and all
  132 exhaustive real-Git tests.
- Browser suite: 461 tests in 50 files passed, including composer source round
  trips, menu focus, partial bulk failures, file refetch/save conflicts, timeline
  anchors, panel resize and background cloning.
- Desktop smoke passed on macOS arm64. Linux clipboard and Windows process-tree
  paths have automated coverage; native packaged tests on those platforms were
  not run here.
- Production web build passed its bundle budget: 1,296,248 initial JavaScript bytes
  versus 1,287,890 before this phase (8,358 additional bytes).

The first candidate benchmark completed its soak but was rejected for an unknown
`projects.cloneList` request in the synthetic server. The fixture now returns an
empty job list. Both baseline and candidate are measured with this same correction;
no workload size, timing threshold or memory limit was changed. Benchmark results
are ignored artifacts, not committed reports. Final comparison follows below.

### Measured comparison and outstanding acceptance

Both corrected acquisitions contain five warmups, thirty repetitions and all
11 samples over ten minutes. The baseline was captured September 25; the candidate
was captured September 28 after the interrupted implementation session resumed.

| Interactive measurement (p95)  |     Base | Candidate |
| ------------------------------ | -------: | --------: |
| Small-thread startup           | 140.3 ms |  164.2 ms |
| Warm large-thread switch       | 183.5 ms |  194.4 ms |
| Composer input                 |  17.8 ms |   18.2 ms |
| Composer input while streaming |  16.1 ms |   16.1 ms |

Startup exceeds both the 10% and 20 ms regression thresholds. This is an unresolved
acceptance failure, not a passing comparison. Investigation found severe host
contention after the candidate run (one-minute load approximately 280 on 14 cores).
That observation is not proof the code has no regression. A contemporaneous
baseline and candidate must be measured on an otherwise quiet host before closing
performance acceptance. No thresholds were relaxed.

Browser retained growth in the final five minutes is 6,301,608 bytes (11.99%),
versus 4,955,464 bytes (9.60%) before. Both violate the existing 5% growth gate;
both pass the 10 MiB absolute bound. Candidate server growth is 159,192 bytes
(0.10%) and combined growth is 6,460,800 bytes (2.98%), both passing. The unchanged
slow-client fixture still buffers 4,148 frames against the Phase 2 target of 2,000.
The comparison command correctly fails for startup latency, browser growth and
pending frames. Phase 3 implementation is reviewable, but performance acceptance
and the remaining Phase 2 bounds are not complete.

Raw artifacts are `.performance/phase3-before-v2-interactive.json` in the isolated
baseline checkout and `.performance/phase3-after-v2-interactive.json` in the feature
checkout. Fixture digest is
`4478762c808f2d2dc3721ff922a46b28086472f1173491833ff0efc026056c19`.
They include hardware, OS, runtime, browser and dependency versions. Results here
are from macOS arm64 on an Apple M4 Pro.

### Final rerun under host contention

The September 28 full-suite rerun did not pass: the scripts suite reported 14
five-second timeouts across ledger/history/migration tests, and the server run
also timed out the existing real-Git profile credentials test at 15 seconds.
Turbo stopped after the scripts failure, so that rerun did not reach the exhaustive
Git matrix. These tests were green in the prior full run reported above. The new
clone tracker tests passed in the final rerun. No test deadline was increased and
no failure was waived. CI or a quiet-host rerun must validate the final revision;
this report does not call the PR merge-ready.
