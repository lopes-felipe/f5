# October 2026 upstream catch-up classification

This artifact tracks triage separately from delivery. `scripts/upstream-ports.json` is the only delivery authority. A `planned` classification remains deferred until a scenario has implementation or equivalence evidence.

## Current review handoff (2026-10-20)

Implementation is on `fix/upstream-october-review` in the isolated checkout
`../f5-upstream-october-review`. Main `83e054f412` is integrated additively after the preceding `f711d43051`
merge; user work in the original checkout remains intact. The implementation
through `abaaa91e91` includes guided reviews, scoped thread tools, HTML renders,
manual GitHub reset waits, durable PR watches, persisted settlement, Codex MCP apps
and per-project provider policy. The current continuation adds PR review filters,
per-item forge permissions, thread-owned PR panels, reference chips and opt-in
merge-message attribution cleanup, forge-aware quick actions opt-in branch cleanup and custom local ACP agents. It also repairs cross-feature migration and
runtime integration and attaches per-SHA implementation evidence. Saved-branch settlement
now verifies ref identity and exact PR heads, and Find in thread searches persisted
messages and plans through a dedicated read connection. Migration 130 and protocol 38 extend the merged baseline. Pi native continuation/rewind, persisted Find, Agents lifecycle/account metadata and shared ACP failure isolation now have focused evidence; their remaining workstream and release obligations stay open. Coverage remains 4,084 ledger records;
implementation work does not automatically promote deferred obligations.

The full gate and verify-first/security obligations remain incomplete. See
[the review response](./upstream-october-review-response.md) for the current
validation and remaining work.

## Frozen selection

- Base: `f5ef0ddb90a8c36584e181b1913e7b8a5df30ffc` (2026-09-23).
- Target: `da7c4f234db35096af2c16d5e24c60dbe9495583` (2026-10-17).
- Selection: `git rev-list --first-parent base..target`, newest first.
- Count: 1,752 unique commits.
- SHA-list digest (LF-joined with a final LF): `863fdeb7e3232508be82ddc98dd7b861325e921565089c6d3eb9b5b3b2468100`.
- Ledger: 4,084 records, comprising 3,588 interval commits and 496 legacy commits.

## Rule order and review boundaries

1. Explicit SHA and PR decisions, including accepted, declined and excluded features.
2. Follow-ups to September features retain the September workstream id.
3. User-visible shared-subsystem fixes and performance changes require scenario verification in 15a, 15r, 15t or 15u.
4. Mechanical exclusions follow source inspection. Runtime refactors are retained as deferred when there is no proof that they are behavior-neutral. Mobile-only source changes have no shared f5 runtime to port; mixed web/mobile changes retain the web work.
5. Product declines retain f5’s inbox, tool cards, icons, branch prefix and explicit compaction behavior.
6. Equivalence requires local source and implementation SHAs.
7. Remaining changes stay individually deferred. The title of a refactor or chore never proves that it lacks behavior.

The artifact deliberately retains runtime changes whose source/scenario review is unfinished. It does not assert that all verify-first cases have been reconciled. Review references use immutable upstream SHAs, available through `git show <sha>`. Each planned SHA has a scenario id and target module in the artifact.

## Counts

| Classification                                                  | Commits |
| --------------------------------------------------------------- | ------: |
| `declined`                                                      |      11 |
| `deferred`                                                      |     445 |
| `equivalent:apps/server/src/storage/databaseSpace.ts:1`         |       2 |
| `equivalent:apps/web/src/lib/nativeTaskActions.ts:14`           |       1 |
| `equivalent:packages/shared/src/codexProtocolManifest.ts:6`     |       2 |
| `equivalent:packages/shared/src/model.ts:591`                   |       1 |
| `equivalent:packages/shared/src/model.ts:71`                    |       2 |
| `not-applicable:devices`                                        |      15 |
| `not-applicable:maintenance`                                    |     177 |
| `not-applicable:marketing`                                      |       3 |
| `not-applicable:mobile`                                         |     136 |
| `not-applicable:multi-environment`                              |       3 |
| `not-applicable:relay-cloud`                                    |      48 |
| `not-applicable:release-ci`                                     |       4 |
| `not-applicable:upstream-only-subsystem:context-handoff`        |       3 |
| `not-applicable:upstream-only-subsystem:lineage-delegation`     |      11 |
| `not-applicable:upstream-only-subsystem:opencode-2-inbox`       |       1 |
| `not-applicable:upstream-only-subsystem:source-control-gitcafe` |       2 |
| `planned:10`                                                    |      49 |
| `planned:11a`                                                   |      46 |
| `planned:12a`                                                   |     102 |
| `planned:13b`                                                   |      57 |
| `planned:15a`                                                   |     193 |
| `planned:15b`                                                   |      16 |
| `planned:15c`                                                   |      21 |
| `planned:15d`                                                   |      11 |
| `planned:15e`                                                   |       6 |
| `planned:15f`                                                   |       1 |
| `planned:15g`                                                   |      18 |
| `planned:15h`                                                   |      11 |
| `planned:15i`                                                   |       8 |
| `planned:15j`                                                   |      12 |
| `planned:15k`                                                   |       8 |
| `planned:15l`                                                   |      21 |
| `planned:15m`                                                   |      13 |
| `planned:15n`                                                   |       2 |
| `planned:15o`                                                   |      21 |
| `planned:15p`                                                   |      12 |
| `planned:15q`                                                   |      10 |
| `planned:15r`                                                   |      29 |
| `planned:15s`                                                   |      10 |
| `planned:15t`                                                   |     158 |
| `planned:15u`                                                   |      45 |
| `planned:15v`                                                   |       5 |

## September carriers

The frozen set has 299 unique SHAs, SHA-sorted digest `4f6231f46344259953bb78400a81fd22d106613aa954cd38ebe99e4f822003ed`. The current baseline has 12 original workstream ids; splitting 13d into its carried and retained subsets yields 13 carrier partitions. All original ids and existing proof are preserved.

| September set  | Carrier                  | Members |
| -------------- | ------------------------ | ------: |
| `10`           | 15o                      |      30 |
| `11`           | 15t                      |       1 |
| `11a`          | 15q                      |      22 |
| `11c`          | 15t                      |       3 |
| `12a`          | 15j                      |      90 |
| `12b`          | 15j                      |       3 |
| `13a`          | 15s                      |       1 |
| `13b`          | 15s                      |      31 |
| `14`           | 15s                      |      25 |
| `2`            | 15a                      |      89 |
| `3e`           | 15o                      |       1 |
| `13d:preview`  | 15o                      |       1 |
| `13d:deferred` | carried forward deferred |       2 |

15b handles diagnostics within September set 2. The other 458 previously unassigned deferred records remain outside this round unless named as prerequisites. Carriers are reconciliation obligations, not evidence that a delivered feature needs rebuilding.

The 26 September settlement exclusions are overlaid as deferred/15c with reason “Reclassified 2026-10 by user decision”. The September JSON remains untouched. Reapplying September followed by October restores the overlay and preserves completed proof.

## Product decisions

Accepted: HTML renders, Mermaid, MCP apps, Claude `/goal`, PR hub additions, per-project providers, custom ACP agents, Pi, scratch threads, projects from a name, prompt links, settlement, opt-in native usage history, the standalone CLI installer, gated passkeys and bounded diagnostics with opt-in OTLP.

Declined: Working sidebar, secret-request cards/history scans, macOS default-browser registration, `t3/` branches, cardless tool rows and related redesigns, Morph icons, compact-before-send, mobile-app promotion and the anonymous-usage note. Preserve final upstream reverts: no automatic pre-resume compaction, file-link repair or trailing toast icons.

Excluded architecture: devices/simulators, webhooks, outside-agent OAuth, relay/cloud, multi-environment, GitCafe, Lineage/delegation/child threads, context handoff, scheduled tasks, analytics-feedback and the Tiptap composer. Keep f5’s Agents panel, Lexical composer, model catalogs, profiles and Agent Bridge.

New automatic behavior remains off. Existing defaults for usage-limit resume, restart resume, automatic default-branch pulls and storage cleanup remain unchanged. SQLite keeps its current synchronous level. The separate reader worker (#19382) is deferred: f5 uses one connection behind a semaphore; revisit if `perf:server` shows read blocking.

## Required cut line

Phase 0, 15u-1, 15a-1 and 15v must be delivered, and every verify-first item in 15a/15r/15t/15u needs an evidenced ported, equivalent or not-applicable decision, before treating the interval as caught up. Other work may remain deferred with its workstream id. Pinning coverage records review scope; it is not completion credit.

## Baseline and validation

Implementation is isolated in `../t3code-october-2026`, branch `f5/upstream-october-2026`, initially from origin/main `0b07438184417a6f82f91105609d8b404d8ae643`. The shared checkout has not been modified. After review, origin/main `97df84626a` was merged without rewriting history. It includes migration 119 (`WorkspaceTransitions`) and released protocol 25, so the next migration is 120 and the October bundle uses protocol 26. Workspace transitions remain in the generated-branch path; the prepared commit is revalidated after a coordinated switch, and a stale result reports an already-created branch accurately while suppressing commit, push and PR creation.

Baseline checks (Node 26.11.1, Bun 1.3.11):

- Focused FileViewPanel: 9 passed; the reported timeout did not reproduce.
- Scripts: 324 passed, 2 failed before changes. Both failures are migration recovery’s OS creation-identity lookup: this host rejects `ps` with `EPERM`. Recovery correctly refuses to proceed when identity cannot be verified. No assertion or recovery protection has been weakened.
- October artifact tests: 6 passed. The scripts suite still has those same two baseline failures.

Final validation results and delivery proof are recorded separately; this document does not declare the catch-up complete.

## Implementation status (2026-10-18)

This is a partial implementation. The catch-up cut line has not been met and the broader accepted feature work remains deferred.

- Phase 0 tooling and triage: `554be0af57`. Exact interval coverage, frozen September carrier membership, settlement overlays, replay preservation and deleted-classification guards are implemented. The three final upstream reverts remain verification obligations, rather than being mislabeled as behavior-neutral maintenance.
- 15u-1 cleanup safety and Git argument hardening: `2a14ab0c6d`, with checkpoint-ref follow-up in `98b3ebb081`. After review, the probe lists untracked files regardless of repository configuration, collapses ignored directories and uses a separate bounded pathspec scan for protected environment-file segments at any depth. Both ignored scans report truncation and fail closed. Automatic cleanup audits other ignored paths with a bounded UTF-8 preview and omission count. Manual removal retains the original conservative policy (only dependency directories may be removed). Real-Git tests cover over 1 MiB of ignored paths, nested secrets, truncation, hidden files, ordinary output and lifecycle races. Worktree creation also terminates options before paths and refs.
- 15u-2 commit generation: context is built with a disposable index, preserving partial staging, materializing split-index dependencies and retaining Git's racy-edit detection. HEAD, real-index bytes and the included tree are revalidated under the repository lock after generation. A changed context preserves the entire suggestion, creates no feature branch and performs no commit, push or PR request. Feature-branch creation occurs only after validation. Coverage includes concurrent staging, HEAD movement, included edits/deletion, unrelated edits, unborn/missing/conflicted/split indexes, cancellation and same-size racy edits. The full real-Git matrix passes 153 tests; the changed-context UI and goal header pass 10 Chromium browser tests. The clone-cancellation fixture now uses context-independent polling with the same assertion and 10-second deadline.
- 15a-1 SQLite implementation: `f049aa6364`, followed by review fixes. Node connections retain FULL synchronous writes, enable checkpoint full-sync and avoid cached prepare failures. Node and Bun write transactions begin immediately; `withReadTransaction` uses deferred BEGIN on the same reserved connection for consistent multi-query snapshots without taking a write reservation. Startup bounds retained WAL size and optimizes planner statistics after migrations. The Node worker has one outstanding request plus one pending check, a default-checkpoint fallback and WAL diagnostics. Contention is reported only after an incomplete passive attempt, with no claim that a reader is the only possible blocker. Unknown NOOP progress retains the previous state; busy/incomplete checkpoints retry while idle, including after an external reader releases without another writer command. The 23 correctness tests cover a 100 MiB write, pinned readers, startup failure and worker exit, exclusive-lock recovery, nested read snapshots, and separate Node/Bun processes contending before their first transaction read. The dedicated 40 MiB checkpoint benchmark completed five warmups and thirty measured repetitions; the latest largest measured event-loop p99 was 1.750015 ms, below 50 ms. Its raw report is `/tmp/f5-october-checkpoint-measurement-2.json` and records source-dirty status, source commit, runtime, hardware and fixture/harness digests. Other comparative performance and retained-memory gates remain outstanding.
- 15v preview/startup protection: `98b3ebb081`. Snapshot extraction runs in an isolated renderer world, masks password/CSS-masked values in text, names, selectors and diagnostics before truncation, rejects oversized secrets, and bounds hung or navigating captures. Token-bearing browser launch effects are excluded from tracing. Cross-origin child-frame coverage in Electron is not yet verified, so #20446 remains deferred.
- 15f Claude goals: root synthetic `/goal` output and Stop-hook feedback now publish the existing `nativeGoal` metadata. Successful root model completion clears the active status; command-only, stopped, hook-blocked and failed turns retain it. Cursor metadata restores goals after a restart, and ordinary or child model text cannot set or clear them. The existing Codex native-operation path keeps goal control operations outside the conversation-turn count. The Claude adapter and goal/resume suites pass 302 tests.
- 15u/15a passive Git reads: a pre-fix reproduction showed a timestamp-only change causing status polling to rewrite the real index. `diff-files`/`diff-index` now preserve both the index and the existing status totals; GitService disables optional writes, and automatic status/checkout refresh fetches use `--no-auto-gc`. A real Git trace verifies that polling does not start maintenance, with an ordinary-fetch positive control. Legacy worktree listing retries only the pre-2.36 `-z` usage error, decoding C-quoted Unicode/control characters while retaining literal whitespace. Unrelated errors remain visible. Existing explicit index-lock reporting is retained.
- 15b local tracing: the retained queue is capped at 4,096 records and 4 MiB of UTF-8 data, including the dispatched batch. Old pending records drop first; oversized and failed batches are counted, rather than replayed. One owned writer process performs file I/O and rotation, with bounded batches, failure backoff and a 2-second local shutdown deadline. A real FIFO regression demonstrated that a blocked filesystem call in a worker thread prevented Node from exiting even after `terminate()`/`unref()`; the separate process fixes that case. It uses the standalone private runtime where present and does not inherit provider credentials. External export, Diagnostics UI, heap capture and the other 15b signals remain unfinished.
- Existing 15v protections have separate equivalence proof: internal Claude catalogs are in-process SDK servers; Windows npm shims resolve to direct Node invocations; f5 has no DPoP/relay replay-marker producer. The Git option-hardening record is ported.

Feature commits do not change the delivery ledger. Separate ledger commits record only verified per-SHA proof. Artifact reapplication preserves that proof. The ledger includes the separately verified Claude-goal port. Commit-generation delivery proof is recorded only after its feature commit; no unresolved performance, security or carrier obligation is promoted automatically.

At the original branch baseline, the 299 September carrier obligations and 26 settlement overlays were preserved without delivery reconciliation. Current continuations implement several of these features as described above and in the review response; their per-SHA release dispositions remain deferred. Verify-first triage across 15a, 15r, 15t and 15u, Pi, scratch projects, prompt links, usage history, gated passkeys and the remaining PR/chat/panel work are still unfinished.

## Check results

- `bun fmt`, `bun lint`, `bun typecheck`, `F5_REQUIRE_UPSTREAM=1 bun run upstream-ports:check`, and `git diff --check`: pass. Lint retains repository warnings with zero errors.
- October artifact: 6 tests pass. SQLite: 16 tests pass. Preview snapshot extraction/capture: 8 tests pass. Final extended real-Git matrix: 141 tests pass.
- `bun run test:full`: executed; the fast suite stops at the two reproduced migration recovery failures. The extended matrix was also run independently and passes.
- Earlier full workspaces with `--continue=always`: 8,513 tests passed, 6 failed. Five failures are OS creation-identity checks rejected with `ps`/`/bin/ps` `EPERM` (two migration recovery, three standalone launcher lease cases). The filesystem-watch case that timed out in that full run passed on its focused rerun. This rerun is not a waiver of the failed full gate.
- The full gate was repeated after the goal and commit-generation changes; it still stops at the same two migration-recovery failures. Targeted Git core/manager/smoke tests pass 63 cases, UI result logic passes 54, and Chromium passes 10.
- The focused observability suite passes 22 tests, including real blocked-disk shutdown, inaccessible destinations, overflow, in-flight accounting, one writer, worker-only file writes and both OTLP encodings. The enabled/disabled WebSocket observability checks pass 2 tests. The complete server unit suite after goals and commit isolation passes 4,538 tests with only the 3 known launcher process-identity failures.
- All server test invocations use `env -i` with only PATH and HOME supplied. No baseline assertion, process-identity check or timeout was weakened.

The full test gate and the remaining delivery obligations prevent declaring this catch-up complete. No performance improvement percentage or signed-desktop compatibility result is claimed.

## Observability library spike

The installed effect-smol revision `8881a9b` includes OTLP JSON and protobuf serializers
and exports both traces and metrics without a new dependency. The fake HTTP collector
in `OtlpCompatibility.test.ts` confirms both wire encodings, content types, service
resources and metric/span payloads. `OtlpExporter.ts` uses an unbounded array and can
start another export fiber at each batch threshold; these are not production queue or
concurrency bounds. Production OTLP composition must bound that path and its timeouts
before endpoints or headers are exposed in Settings. This spike does not enable export.

## SHA reconciliation discovered during implementation

The approved plan's passive-read SHA list includes changes from other Git scenarios.
Source inspection establishes the mapping: `f3a69c70c6` is checkpoint provenance
(#17161), `e65063ccf6` is clone option termination (#14781), `aef0e9ca40` is path
whitespace (#12465), and `dd5c7bd09e` is concurrent-fetch recovery (#19411).
The passive index-write fix is `447046b589` (#14718), and disabling fetch maintenance
is `95030dc674` (#13812). Delivery evidence follows each actual diff; these references
do not establish equivalence for the other scenarios.

Pi continuation now registers an explicit-instance Early Access driver with owned
RPC sessions, account admission, scoped F5 MCP credentials, bounded text/tool/image
projection, editable editor prefills, native-history read-back and verified host
rollback recovery. Native extension continuation admission and automatic in-session
rewind projection reconciliation remain outstanding. This is implementation evidence,
not 15l delivery credit; the Pi dispositions and catch-up cut line remain deferred.
See the Pi session continuation in the review response for exact validation limits.

The next Pi continuation wires bounded native wake admission through the durable
queue, with exact-owner adoption, no prompt replay, policy/pause checks and stale
queue cleanup. Assistant-only history survives verified rollback of a later user
turn. A production Node/Chromium fixture also exposed and now covers explicit
instance capability routing. The focused server run passes 285 tests; all eight
typechecks pass. Installed Pi/account evidence, native rewind projection
reconciliation and required full release gates remain outstanding. These changes
do not promote any Pi disposition or satisfy the catch-up cut line.

Pi native in-session rewind reconciliation is now implemented behind exact active
instance/turn ownership and complete same-session ancestry read-back. It removes
only captured abandoned turns and their persisted message links, preserves other
providers and unlocated history, and pauses queued prompts for review. Migration
128 prevents late writes from resurrecting retired turns across restart. Protocol
38 keeps older clients from applying native reconciliation as prefix truncation.
The real built-server/SQLite/Chromium fixture passes without a fork or extra prompt.
Installed Pi/account evidence, remaining metadata follow-ups and the full release
gates still prevent marking 15l or the catch-up delivered.

## Source-inspected compiler maintenance (2026-10-20)

The following 33 full patches were read individually. Their changes fit the user's compiler/test maintenance exclusion. This closes classification obligations only; it grants no runtime port or performance credit. Settings refresh error ordering (#20503), device setup error cleanup (#20488), and stable callback retention (#20556) remain open because those patches also affect runtime behavior.

| Upstream SHA                               | Source result                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `b103346ba6a3a599c85a8c108f9aa4875c1f4d16` | combobox context construction only removes useMemo around the same literal.                                                          |
| `1e42057c97bad2194a836f73ce8a9b71930fc5be` | GuideStop computes the same letter-stop notes without useMemo.                                                                       |
| `23d40e0a8cc40c516b05fd6dd1c0840d7ed0f875` | ProjectIconPicker applies the unchanged icon filter without useMemo.                                                                 |
| `99544c9c1904473e234323c90c0a18af62aae4a6` | RedactedSensitiveText removes useMemo without changing its redaction algorithm.                                                      |
| `99fac2687d43d50d523b440b06f20750c362f06b` | file reveal returns the same callback body without useCallback.                                                                      |
| `dc060b113288753c0900911a97c0911899d265d1` | new-thread links call the unchanged search parser without useMemo.                                                                   |
| `49c51bb11a4ad21d572119b55eb746a6f071cadf` | main navigation uses the same pop-out callback body without useCallback.                                                             |
| `f241e7988d3d3347368c8aa32693a6b2391d7a61` | resource telemetry uses the same retry callback body without useCallback.                                                            |
| `daf4643356c77feca9274bc8a62068eef93290ea` | project-file queries use the same refresh callback bodies without useCallback.                                                       |
| `dab2d5c771e2fff27e55d8f23e940702793456b8` | ProposedPlanCard inlines its existing expand callback into the same find ref.                                                        |
| `16e6a6ab50c39206108f3bf6f9e3d9be6d87ba4b` | AnimatedHeight changes only a lint comment and formatting; effect dependencies are identical.                                        |
| `366106ac510a0b254a6ac746d3ae2db34975b19c` | back navigation removes useCallback around the unchanged navigation body.                                                            |
| `6d22719b03cb25f11fa1b843bcd966dff4ba4ae9` | CommandPaletteResults removes useCallback around the unchanged highlight handler.                                                    |
| `6f68d6d7d50054530819b2b84323d75faf6bc9f2` | primary session refresh passes the existing global refresh function in place of its zero-argument wrapper.                           |
| `0b110ce0dbd730a3e24acd605cec322e5300294a` | ThreadFindBar changes only a lint comment and formatting; focus dependencies are identical.                                          |
| `e08b38a9f8fa3071f0c3a150cd6187448dc66b8a` | T3 Connect account settings unwrap the existing open callback.                                                                       |
| `2ff8e7413b75de485066c4754cf3cb85f950b12e` | SnapShotShortcut unwraps the existing stop callback without changing cleanup.                                                        |
| `e6483180610d8364c052b733998d11c4afe1665f` | ModelPickerSidebar changes only a lint comment and formatting; dependencies are identical.                                           |
| `54b191547218b1e88754a0ea81976c7836873ba7` | context drop changes only a lint comment and formatting; listener dependencies are identical.                                        |
| `19a760c3e32005e10eb96d33bad81aaa836a1306` | PierreEntryIcon calls the same icon resolver without useMemo.                                                                        |
| `7c74a35ea6766a6c4567164da896da51457f300d` | ShellCommandBlock computes the same shell embedded-script list without useMemo.                                                      |
| `e9712d261e74ca54e7fb662d7a04a033423aa0f8` | ToggleGroup removes a memoized literal and spells out the same undefined-only size default.                                          |
| `3ff9a734584b92f5220e8abc1fed18a5e4aebfa8` | useAtomCommand returns the unchanged command callback without useCallback.                                                           |
| `fad673225650193fad2a85487ecffc903f8ff30a` | only tests and a test-helper comment change to existing renamed layer factories.                                                     |
| `6805b64e3917f974708f9a104971db4face70b2d` | ProviderModelPicker performs the same instance lookup without useMemo.                                                               |
| `22585fd9ff701ff4f43b38f8a045440002618a05` | managed relay hooks unwrap the same refresh callbacks.                                                                               |
| `e36d0b2d1f3c7eee763ab566accf50fc601d5234` | archived-thread hooks compute the same environment key and refresh loop without memoization.                                         |
| `54d090062732280987a1f3e1515e44491618d063` | device access hooks construct the same success payload without useMemo.                                                              |
| `1b13922a25ffab315639b636d101fd8406e2e34a` | CLI authorization unwraps the sign-in callback and reads it through useEffectEvent without changing authorization or redirect logic. |
| `54bffb912e82b514deef44769cb68f84758538ba` | CustomModelEditor computes the same presets and model candidates without useMemo.                                                    |
| `c7fe6d37b3a328fb5427b330d1cb11ae66a6da14` | device controls inline the same host/device request fields and depend on their primitive values instead of a memoized object.        |
| `68b47e71c057164b9ee40681a7a73681c39659cf` | ThreadNotificationCoordinator unwraps its callback and retains the same notification cleanup loop.                                   |
| `687f1e94872e7b7191355a536aac3f3070379f1c` | ZoomableImage unwraps the same zoom callback without changing clamp or viewport calculations.                                        |

## Further source-inspected compiler maintenance (2026-10-20)

This second source pass reads 40 more full patches and closes 31 compiler-only cases. Each result below records the unchanged computation, guard or subscription body. It grants no runtime port or performance credit. License reload state (#20608), source-control save cleanup (#20498), late theme adoption (#20574), first-run state timing (#20637), notification permission cleanup (#20504), breadcrumb state timing (#20651), SSH prompt cleanup (#20490), index-route retry fencing (#20580), and telemetry-save cleanup (#20500) remain open for runtime or subsystem review.

| Upstream SHA                               | Source result                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `3603057fe437658c6d427e587f25688b6114a317` | onboarding completion hoists the unchanged async callback into a module function.                                               |
| `35548e27e875577f10d263d4a532fcd214540fdd` | command output moves the same terminal span calculation from useMemo to a compiler-memoized helper.                             |
| `92b896710b43e4e4f0a3cec73eb246658979a102` | ExpandedImageDialog unwraps the unchanged image-navigation callback.                                                            |
| `506955372a24ec02c5dea6b5803add87ff0107ae` | server update banners construct the same Atom and environment projection without useMemo.                                       |
| `fea5380159feb04b6d21233fadfb0705b30fa67d` | find reveal keeps the same beforematch listener and cleanup in a compiler-memoized ref callback.                                |
| `ed866ae1489b84d5e0a81f49749111b735a66654` | turn diff summaries keep the same null case and derivations under a compiler memo directive.                                    |
| `855cd1650c73487b07ba6ee2cbf830670bc311c7` | FontFamilyPicker captures the same mount-only initialOpen value in state and unwraps unchanged font filtering.                  |
| `3ba121e9e843fbbc66111e65c18e37b6f102a56d` | chat shortcuts compute the same sidebar project-group count without useMemo.                                                    |
| `3f5c16fa2b97597f85ec31dff5dc4db06f377483` | settings project groups construct and sort the same snapshots without useMemo.                                                  |
| `de89a7a76dfae79c1defbd7baa9cd7abd5154a6f` | live refresh reads the same latest callback through useEffectEvent instead of a ref; listener and throttle rules are unchanged. |
| `d42681d06ff6417f510a4fe70d31cc7739a3fe8b` | resizable widths unwrap the unchanged finite-value and min/max clamp callback.                                                  |
| `e3a578f2d1f888776e64153c12ceb5d9e32edd35` | environment hooks unwrap the same presentation projections without useMemo.                                                     |
| `63318a5d817871deeecb6e7a58ecff7cba52b1d9` | GuideTour computes the same stop paths and diff-loader options without useMemo.                                                 |
| `66eee62db101625fc62d1185fb49677720a3dc0b` | port discovery hooks unwrap the same query projection and thread-port filter without useMemo.                                   |
| `745ca81b9d8acc447ba0336984fbca85e9698ed4` | useAtomQueryRunner unwraps the same command execution callback and options.                                                     |
| `567bc559acbf3d092cdf35855fe0df9b14497f46` | useActiveThreadRef retains the same id-keyed thread-ref conversion with guarded lazy state instead of useMemo.                  |
| `e544a4a1f6dc599eea71e9b2fb7f28d0ed9cbe02` | useMediaQuery unwraps the same matchMedia subscription, cleanup and snapshot callbacks.                                         |
| `b413396fe8c7f202a52351bc4eff2d7c88ebee2e` | toast route refs unwrap the same server/draft/null selection without useMemo.                                                   |
| `4e8b5eeb05d0e9bde82407594e4fe1e373ca6a10` | discovered local servers unwrap the same scanner/configured URL merge without useMemo.                                          |
| `f63f0261d1223cf59f58a288cefc2cb1f91e53f0` | HTML render themes unwrap the same color and font projection without useMemo.                                                   |
| `ef2d631a556318be0b0342262a4b6224323efc8e` | environment-mode selector builds the same local/worktree/previous-worktree options without useMemo.                             |
| `97a9ca11d224f43701f9fdcffe29444a4f7536db` | session scope hooks build the same permission-set Atom without useMemo.                                                         |
| `15a8774dbad09c63f7517e63279cfa9197afe1e7` | code-block languages inline the unchanged language-list and query filtering without useMemo.                                    |
| `65ebf8f86e33a1f65edfb371b7d5bcc0d96a0f3f` | primary cloud links unwrap the same connection target and refresh callback without memoization.                                 |
| `cba00ae1971fb42e140527ce4755a7a01976cfbf` | highlighted tokens extract the same tokenizer and keyed-line calculation into a compiler-memoized helper.                       |
| `452d032a2a2e47bced99ba662a1eda18f9edd116` | project-file scripts inline the same missing/loading/invalid/valid branches and unchanged parser call.                          |
| `02d48aec5c75e6abb90d06fd2c63939a82bd3718` | guide file diffs unwrap the same defensive metadata clone and view options without useMemo.                                     |
| `2bb92ba474f311644137dcb1b6eac604c504bbee` | environment selector unwraps the same active lookup and option construction without useMemo.                                    |
| `242ec0ea2b89a1d5f28a5baa8bf5f89fe9835cbf` | highlighted search lines extract the same try/catch tokenization fallback and unwrap range normalization.                       |
| `dd1ab3f059f16cc46b59c5620bd2df706df2e4f8` | orchestration commands unwrap the same authorization guard and execution callback without useCallback.                          |
| `41f56d96d8e6dc92129ef156f6a8372510d410db` | project scans construct the same query Atom and registry refresh callbacks without useMemo.                                     |

## Third source-inspected compiler pass (2026-10-20)

This source pass reads 25 more full patches and closes 16 compiler-only cases. Nine patches involving browser-theme mount timing (#20585), media cleanup (#20487), inspector row identity (#20545), settings search state (#20628), updater state/cleanup (#20484), device cleanup (#20489), diff selection timing (#20631), search-window timing (#20641), and capture-shortcut cleanup (#20511) remain open for runtime or subsystem verification. No runtime delivery or measured performance credit is granted.

| Upstream SHA                               | Source result                                                                                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `998bcc226a70f307913296b859b02c80456b7100` | project favicon choices unwrap the same picker-match mapping and selected-file callbacks without useMemo.                                           |
| `c712852d96ddc896cc347453916d134c3fdeeeb5` | update-everything builds the same environment and permission-status Atom without useMemo.                                                           |
| `b78296a60b63f8721ae28b3c8a1b517f33bef90e` | TraitsPicker unwraps the same custom/sticky model-option callback without useCallback.                                                              |
| `72b3340a168b02eb4f582d8f3e035a141da96235` | sidebar chrome unwraps the same resize, navigation and mobile-close callbacks without useCallback.                                                  |
| `9e88a4f5935369eb24ecaaea43148ee9f5fe955e` | sidebar update capsule unwraps the same timer subscription and machine-status Atom without memoization.                                             |
| `dec20cedc8145da7bed936a708bc96d9e363c402` | project scripts inline the same preferred-script fallback, import filter and submit callback without memoization.                                   |
| `f0e060a3865d7d77300a920cef4c4405658d5579` | CLI command settings unwrap the unchanged install/uninstall Promise chain and pending-state finalizer.                                              |
| `3c6df713d3d5dd6863183db8bef38aef5ed25b69` | terminal hooks inline the same attachment, error, known-session and running-subprocess projections without useMemo.                                 |
| `0ed3ae8a2d6e2fc3173fd3e0dec6caedcbcbee58` | remote open inlines the same unresolved case, SSH alias and target-resolution projection without useMemo.                                           |
| `c5310c26171024e5c1e671d1c33ea092f986b9ca` | HTML document frames inline the same modifier resolution, blocked shortcuts and deduplicated shortcut mapping without useMemo.                      |
| `c8b3ebfdea50371f0f5e361d96c303167d7089ce` | changed-file trees extract unchanged tree/path calculations into a compiler-memoized helper and unwrap the same expansion callback.                 |
| `a72d1fcc5a89b3576cccaa6f062ba7cda1589fc5` | device-host checks move the same running-set cleanup from try/finally to Promise.finally on checkDeviceHostConnections, which is an async function. |
| `6a0587c9599f808840d8f63eb09d9481007c22cc` | agent authorization unwraps the unchanged approval/deny callback, CSRF selection and redirect handling without useCallback.                         |
| `d209e56e00e96977d5e13afb6f117983c854deba` | sidebar project groups inline the same preferred ordering, labels, grouping and final sort without useMemo.                                         |
| `8fcdcfe2089e743291978ebc6a9b2d8db516579f` | link opening unwraps the same in-app/external policy, interruption and history handling without useCallback.                                        |
| `6ad62b8ab1a5bd3fdaa8fe84bf307c4d44a27818` | project-file choices unwrap the same fuzzy matches, labels, icons and open-file callbacks without useMemo.                                          |

Three retained mixed compiler patches close by product scope after full source
inspection: `7157b766996fcf983cdf76e15bf23465329e886d` (#20488) and
`488af8d28b8ccbc11b83445af9ec0d0cbe48f1f8` (#20489) touch only DeviceSetup or
DevicePanel runtime code and their compiler-list entries. The user excludes that
device workspace. `079a349708dd6a257fd25576378fa1de105e327c` (#20490) touches only
the native desktop SSH password dialog and its compiler-list entry; SSH connection
management is excluded with multi-environment support. These are scope decisions,
not claims that the error-cleanup rewrites are behavior-neutral.

## Fourth source-inspected compiler pass (2026-10-20)

This pass reads 39 complete patches: 26 qualify as compiler/test maintenance, and four concern only excluded load balancing, T3 Connect relay/cloud or device-host management. Nine mixed changes remain open: media video lifetime (#20486), fullscreen IPC caching (#20569), color-picker state (#20525), thread status callback ownership (#20630), file-save session lifetime (#20697), pending-input timing (#20592), update failure cleanup (#20478), theme index state (#20655), and settings result selection (#20623). Across all four passes, 140 complete candidates have been inspected: 106 mechanical exclusions, seven excluded-subsystem decisions and 27 retained runtime obligations. The remaining 33 larger candidates have not been source-reviewed in this pass. Classification alone grants no runtime port or measured performance credit.

| Upstream SHA                               | Source result                                                                                                                                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `6515be7f4bd34a6d69e4f40b7f615e438aa235d0` | not-applicable:maintenance: project clone toasts hoist the unchanged action helper and unwrap the same draft-check/open callbacks; the hoisted helper leaves effect dependencies.                                                                                  |
| `aca2b2ab4e82afcf99482fdd09cf502112829842` | not-applicable:maintenance: scoped model availability unwraps the same per-environment capability and model-option checks without useCallback.                                                                                                                     |
| `f0474d37d7d4986bbef7835745e04d5a4c9e717f` | not-applicable:maintenance: resize handles unwrap unchanged flush/finish callbacks and read them through useEffectEvent; moved flags retain their boolean logic and effect listeners no longer depend on a render callback.                                        |
| `696e0e4314a44e4614438f9c3142ddb8b5e10cbc` | not-applicable:maintenance: asset URL hooks extract the identical file-resource predicate and preserve result indexing while unwrapping refresh and URL projections.                                                                                               |
| `c36880ea67221d81a1dcfedd462c483cd4400b1f` | not-applicable:maintenance: project action settings unwrap the same importable-script filter and payload/submission callback without memoization.                                                                                                                  |
| `9ef927496573c059f9f3b06d0faa4cee37e0e993` | not-applicable:maintenance: ChatView extracts the same unseen-wake predicate into a pure tested helper; filtering invalid visits and requiring every valid visit before the wake is equivalent to the previous maximum-time check.                                 |
| `530d119655d64f6999dd76b2261636c548ff5634` | not-applicable:maintenance: remove-cloned-project unwraps the unchanged deletion, failure, post-await route check and upload/draft cleanup callback without useCallback.                                                                                           |
| `4e8c01c1bc251bf948adb0c0484b8b4b9aba8c74` | not-applicable:maintenance: chat canvas unwraps the same equality-guarded preview/details callbacks and unchanged layout/context construction without memoization.                                                                                                 |
| `ef643a3f0e7b10aa7f66dca9b4f017d7ce7865e1` | not-applicable:maintenance: scheduled-task settings unwrap the same editor callback, environment/task Atom, project filter and provider model projections without memoization.                                                                                     |
| `222ebe071e4c825574d37b180c8ab60dfecf3c15` | not-applicable:maintenance: pairing surfaces retain the same initial URL token and one-shot submit guards through lazy state/useEffectEvent instead of mount-only refs and memoized callbacks.                                                                     |
| `9b62eae950e380752a94e797105832e19dfed20d` | not-applicable:maintenance: settings layout unwraps the same context, search-target callbacks and settings map; project override calculation moves unchanged into a pure helper.                                                                                   |
| `73d9a77e43ee7cdc099726129d56576d5835c109` | not-applicable:maintenance: open-in picker preserves the same editor resolution and local/remote policy branches in a compiler-memoized helper and unwrapped callbacks.                                                                                            |
| `2520821d575fb769875f67fca1b9c62784817452` | not-applicable:maintenance: device stream views extract unchanged aspect/rotation calculations and replace callbacks that capture only stable setters/refs with stable forwarders; frame, reset and input behavior is unchanged.                                   |
| `0fdbb37478dedd328bfb908e9b20bb3b2061d5dc` | not-applicable:maintenance: ThemeEditorHost unwraps the same merged/existing/new-theme save branches and storage-failure checks without useCallback.                                                                                                               |
| `d89076c6d8df27a9e18eda642096f99a910d18e3` | not-applicable:maintenance: storage settings unwrap the same report Atom and retain the same Promise.all cleanup operations with pending reset in Promise.finally.                                                                                                 |
| `934398bc41b7e01278ed75f742894848b2b12578` | not-applicable:maintenance: settings search moves the same primitive availability flags and unchanged filtering into a compiler-memoized helper.                                                                                                                   |
| `c62480abff883376fc5b0d3df16097c468cd526b` | not-applicable:maintenance: query hooks extract unchanged ref-page Atom construction, preserve cursor guards and refresh behavior, and unwrap search normalization/callbacks without manual memoization.                                                           |
| `e6a126095f01ae28f67e71a7b9518b529730dfa6` | not-applicable:maintenance: settings scope context unwraps the same member-file Atom, environment/scope resolution, selected target and provider context without useMemo.                                                                                          |
| `37db94e5204569b54aa773a50806ad57e09e22dd` | not-applicable:maintenance: editor preferences unwrap the same available-editor fallback, permission/error checks and open callback without memoization.                                                                                                           |
| `436ff018d8ac491dee5bff0db209591c251a1e9f` | not-applicable:maintenance: draft hero headline unwraps the same project sorting, labels, scratch exclusion and picker filtering, moving its existing hooks before derived values.                                                                                 |
| `383d8cc6aedc7ffb27984c8dc0a64be6a3b67f7d` | not-applicable:maintenance: scoped settings extract the same server/client merge into a compiler-memoized helper and unwrap unchanged persistence plans, authorization checks and error reporting callbacks.                                                       |
| `8e49f230d8a6267e2ccea9c72f358096d605fa53` | not-applicable:maintenance: Lineage panels extract unchanged subagent maps and relationship graph traversal into compiler-memoized helpers and unwrap the same row derivation.                                                                                     |
| `b82d2e3bd5ba4bbf5bfb009c1713855dbae82e4b` | not-applicable:maintenance: guide excerpts extract identical patch slicing and expansion-loader bodies into compiler-memoized helpers and unwrap unchanged annotations, commenting and view options.                                                               |
| `41edad837f18a742816c4a5bbd1172448e156164` | not-applicable:maintenance: file context menus unwrap identical capability/absolute-path checks, activation, menu construction and handler bodies without memoization.                                                                                             |
| `b618d53941b8bdde151e5b104c47ad29e2447687` | not-applicable:maintenance: project script settings extract the unchanged target-write/keybinding loop into an async helper and retain its saving guard cleanup through Promise.finally.                                                                           |
| `472a62a6a8f6157b9283dcee201f2780ade9a301` | not-applicable:maintenance: sidebar primitives unwrap identical open/cookie/toggle/context bodies, extract unchanged resize options into a compiler-memoized helper and read refresh through useEffectEvent.                                                       |
| `33672c47e3c45a6afabdc1a0dd89033e77237bec` | not-applicable:multi-environment: the entire runtime patch is useLoadBalancedEnvironment, whose host-resource expiry timer and automatic machine selection belong to excluded multi-environment load balancing; it changes no F5 local provider or task scheduler. |
| `ecb973a7df86421adce88120d6de41854705d620` | not-applicable:relay-cloud: the sole runtime file is the Clerk-backed ConnectOnboardingDialog and its cloud publishing/device onboarding state; F5 excludes T3 Connect relay/cloud onboarding and keeps its own remote-access model.                               |
| `c1caac81ab32ec5912ee318aa23c8a2f5119dd8e` | not-applicable:relay-cloud: the runtime patch changes only CloudEnvironmentConnectList relay machine registration, auto-selection and discovery polling, plus its compiler-list entry; F5 has no T3 Connect relay environment catalog.                             |
| `7091bc2495df63174afc4a14d6890c1aab7daf64` | not-applicable:devices: the sole runtime file manages SSH device-host configuration and device-state queries in DeviceHostsSettings, plus its compiler-list entry; this is the excluded device workspace, not a local provider or general forge host setting.      |

## Fifth source-inspected compiler pass (2026-10-20)

This pass reads 26 complete patches: 13 qualify as compiler/test maintenance. Thirteen mixed runtime changes remain open: directory-entry refresh (#20482), integration busy cleanup (#20512), diagnostics signaling cleanup (#20507), theme-editor seeding/inspector timing (#20458), SnapShot stale checks/hydration (#20514), theme-half application (#20473), theme import lifetime (#20513), diff retry/query identity (#20670), project icon failure cleanup (#20509), favorite rollback (#20474), terminal session/layout ownership (#20527), font edit generations (#20528), and model-picker fade measurement (#20706). Across five passes, 166 complete candidates have been inspected: 119 mechanical exclusions, seven excluded-subsystem decisions and 40 retained runtime obligations. Seven larger patches remain only partially inspected and retain their planned classification. Classification alone grants no runtime port or measured performance credit.

| Upstream SHA                               | Source result                                                                                                                                                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `8f309bce656b315aacc93ba54ed6f3933124da0e` | not-applicable:maintenance: welcome wizard retains the same lifetime auto-selection Set in lazy state instead of a ref; callback bodies, provider grouping, project import partitioning and terminal setup guards are unchanged.                        |
| `145b15416a71b1370bf8f6ec1fe4005bcb524877` | not-applicable:maintenance: resource telemetry diagnostics unwrap the same visible-process derivation, process-identity/permission/confirmation checks, signaling cleanup and collector retry callbacks without memoization.                            |
| `70c73d96e0f395c3cea59266699a6d92045959ed` | not-applicable:maintenance: local storage hooks extract identical read/decode/write error and fallback bodies into helpers and unwrap the same event subscription and value setter without memoization.                                                 |
| `36c1fe50ac97748f39e1439bffb2b436d338740e` | not-applicable:maintenance: new-project hooks unwrap the unchanged private-publication, creation/commit-warning, project-arrival and first-draft callback bodies without useCallback.                                                                   |
| `4a9516d3d5e73869fc9d33b744b31ef2f26ba404` | not-applicable:maintenance: chat header unwraps unchanged rename/menu/keyboard callbacks, retains identical breadcrumb dependencies and inlines the same thread-owned menu-timer cleanup.                                                               |
| `65d352eb6d9b59494c7dd28383cc3f9e609ee7c4` | not-applicable:maintenance: annotatable diffs unwrap the same file map, persisted/draft annotation construction, version hash and comment callbacks without manual memoization.                                                                         |
| `d9157773977d2f91992b5fba5a9d2c59ab3e5887` | not-applicable:maintenance: keybindings settings extract unchanged merged options, row groups and anchor IDs into compiler-memoized helpers and unwrap identical permission/payload/save/remove/reset callbacks.                                        |
| `ed16d9f2416951366ecc20607df125912420d558` | not-applicable:maintenance: thread-find navigation unwraps the same reveal callback without useCallback; paging pinning, virtual-row materialization, horizontal code scrolling, retargeting, match ownership and animation-frame checks are unchanged. |
| `afb8da0094cbadc5dd3f23cc4aaf921d2c885492` | not-applicable:maintenance: right-panel tabs replace the latest-action ref with useEffectEvent, hoist the identical stable mount-focus callback, and unwrap unchanged PR references, drag, tab scroll and context-menu callbacks.                       |
| `35dcdfb945374b3baf417b99b157d4d202020d62` | not-applicable:maintenance: source-control action hooks unwrap identical callbacks without useCallback; authorization rechecks, action-manager ownership, error results and command payloads are unchanged.                                             |
| `2dd87a4047a18ad7918e7dc1265469d19d101e0c` | not-applicable:maintenance: build-only React Compiler migration replaces the Babel preset with the native compiler option and corresponding compiler dependencies and lockfile; no application runtime or product behavior is added.                    |
| `c0cdb02a4b8f96df7e077a8e7dadc6da833f3568` | not-applicable:maintenance: thread action menu unwraps identical grouping, capability/permission rechecks, snooze/pin/settlement/archive/delete/copy actions and close callback without manual memoization.                                             |
| `07956d1ac54200f14c0f2b5221d1fe3f81a7cc7f` | not-applicable:maintenance: new-thread hooks unwrap identical project/model/workspace resolution, call-time state reads, concurrent draft reuse and stale navigation guards; ordered projects move to an equivalent compiler-memoized helper.           |
