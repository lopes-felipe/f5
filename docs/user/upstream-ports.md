# Upstream ports

Track the repository your project was forked from. F5 triages each new upstream commit into a
topic, you decide what to port in a few keystrokes, and **Start port** opens a worktree thread
with a prompt that carries the topic's commits and the trailer that completes it.

## How to

1. Add an `upstream` block to the project's checked-in `f5.json`:

   ```json
   {
     "upstream": {
       "repository": "https://github.com/pingdotgg/t3code",
       "remote": "upstream",
       "branch": "main"
     }
   }
   ```

2. Open **Upstream** in the sidebar. If the remote is missing, click **Add upstream remote**. F5
   adds it with pushes disabled.
3. Click **Run now**. F5 fetches the upstream branch and triages every commit after the last
   tracked one. The menu next to it runs with rules only or triages the legacy backlog.
4. Review the **Inbox**: `j`/`k` to move, `a` to accept the suggestion, `p` to mark it ready, `s`
   to skip, `w` to watch, `d` to decline, `e` when f5 already has the change. Each decision is
   saved locally at once and the topic leaves the list right away. With the mouse, use
   **Accept** in the detail pane or the buttons that appear when you hover a row.
5. To decide many topics at once, tick their checkboxes (Shift-click selects a range, `x` and
   `Shift+J`/`Shift+K` from the keyboard). The bar above the list shows the actions for the
   current list.
6. Open **Ready**, select topics and press `Shift+P` (**Start port**), choose **Queue selected…**,
   or click **Queue all matching Ready…** to include every matching topic, including unloaded
   pages. Each thread opens in its own worktree on `f5/upstream-<topic>`.
   **Code review after port** is checked initially. Choose **Reviewer A**, **Reviewer B** and
   **Consolidation** models and their options, or clear the checkbox to skip automated review.
7. Merge the ledger pull request F5 opens (**Track upstream t3code changes (<date>)**) whenever
   convenient. It only touches `upstream/` and needs no line review.

## The daily flow

- In the settings popover (gear icon), turn on the **Schedule** (daily or weekly, at a local
  hour). F5 runs at that time, catches up after sleep or a restart, retries a failed run after 10
  minutes, 30 minutes and 2 hours, and continues a large backlog every 5 minutes until it is
  covered. With F5 unfocused, a notification says how many new topics arrived.
- The header shows when F5 last synced and when the next run is due; click it for the run
  details. The ledger chip (`#228 · 11 unpublished`) shows the publication state.
- Suggestions show as chips such as `Port 92%` or `Skip: mobile 97%`. The dot before the title
  is the user impact (high, medium, low, none). Confident skips with a known reason, no open
  question and no conflict are applied automatically (`decidedBy: llm`). **Skipped** with
  **Automatic only** lists them for spot checks.
- `?` marks an open question: the choice depends on a product preference that
  `upstream/policy.md` does not cover. Answer it in the policy so later runs stop asking.
- Press `/` to search titles, summaries, PR numbers, areas and commit subjects. **Filter**
  narrows by suggestion, impact, area, open question, conflict or who decided; each option
  shows how many topics it would leave. **Sort** switches between priority, newest, oldest and
  confidence. Filters live in the URL and show as chips you can remove one at a time.
- The strip under the Inbox tabs counts the suggestions (`Port 6 · Skip 1,204 …`). Click one,
  tick the header checkbox, click **Select all N matching**, then **Accept suggestions** to
  confirm hundreds of skips in a few clicks. A decision that reaches topics past the loaded
  rows asks first, since you have not seen them. If a batch fails partway, the topics that
  were not recorded stay selected so you can retry them.
- Every decision shows a toast with **Undo**; `z` undoes the newest one. One undo covers the
  whole action, however many topics it decided, for 15 minutes. It restores each topic's
  decision as it was. The epoch stays: undoing a reopen of an In progress topic brings it back as
  Ready, and its old port thread no longer counts. A topic changed since (decided again, or with a
  port thread running) keeps its new state, and the toast says how many. If the undo fails, for
  example while another window holds the repository, the toast comes back so you can retry.
  Undo lives in memory, so a restart of F5 drops it.
- The detail pane lists the **Files changed** across the topic's commits, with line counts and
  a link to each file's change on GitHub. Paths that do not exist on f5's default branch are
  dimmed and marked `not in f5`, which often means the change belongs to a subsystem f5 does not
  have. A commit missing from the local clone shows a note; fetch the upstream remote and press
  Refresh. Topics with more than 50 commits list the first 50, and the panel says so.
- **History** at the bottom of the detail pane shows when the topic was triaged, each decision
  made from this profile (unpublished, published, replaced by a later one or discarded), the
  decision on the default branch when another profile made it, and port threads started or
  unlinked.
- Click **Add scope note** before **Mark ready** to limit a mixed commit to the parts you want.
  On a Ready topic, edit the note and click **Save scope**.
- **Copy port prompt** puts the same prompt on the clipboard without creating a link, for a
  Feature workflow or any thread. The trailer still completes the topic once merged.

## Good to know

- Automated review waits for a `pr` outcome, runs two read-only reviewers and consolidates their
  findings in a standard Code Review workflow, then queues one revision on the port thread.
  The revision uses that thread's current model, access mode and interaction mode. Switch
  back from plan mode before revision if you want it to apply code changes. It pushes fix-up commits to the
  same branch on `origin`, and repeats the port outcome. This adds three review turns and one
  revision per thread, including a grouped port.
- GitHub must be connected so F5 can verify the PR's repository, branch and head commit.
  Temporary lookup failures pause the review or revision until verification succeeds.
- Review status says **revision completed** when that turn finishes. Its detail reports a
  blocked outcome, plan mode or no new commits; the port outcome remains separate.
- Review is skipped for non-`pr` outcomes, unlinking, archived or deleted port threads, and
  merged or closed PRs. A queued revision is canceled when skipped; a revision that already
  started is left running. If the PR head changes before revision, **Retry review** reviews
  the new head. Changes to the base branch alone do not require another review.
- **Open review** opens the reviewers and consolidated report. Retry failed reviewer stages
  inside that workflow. **Retry review** on the port handles setup or revision failures,
  picks up a PR produced by a later turn after an earlier blocked outcome, and can revive a
  skipped review after restoring the port thread. A completed report can be reused; an
  unfinished archived workflow starts a fresh review. Retry keeps tracking any revision
  that already started rather than submitting its feedback again.
- The checkbox state and all three model choices are remembered after each start.
  **Copy port prompt** never triggers automated review. Earlier ports and ledger PRs are
  unaffected. Review completion never marks a topic Done: merged trailers still decide that.

All shortcuts are listed in [Keybindings](../../KEYBINDINGS.md#upstream-page).

## Finish a large backlog

Use **Re-triage failed topics (N)** in the run menu to recover failed Inbox suggestions.
Review and accept suggestions in bulk, then open Ready, narrow the filter if needed, and
choose **Queue all matching Ready…**. Queueing never accepts Inbox suggestions for you.

The dialog previews topic and thread counts on the server. **Start now** keeps its limit of
20 topics in 5 threads. **Add to queue** accepts any number of Ready topics. Choose one thread,
one per topic, or **Batches of up to K related topics** (2–10, default 5). A single thread
always has at most 20 topics.

Batching joins topics that share upstream files or related-topic links first, then packs small
groups from the same area together. Lockfiles and files touched by both at least 10 topics and
5% of the target are ignored. Missing commits use area grouping; fetching upstream restores
their file evidence for a new enqueue.

## Port queue

The queue is persistent and local to the writer profile. Closing the browser or restarting F5
keeps its entries and submission identities. Set **Port threads at once** in Upstream settings
(1–10, default 5). Manual port threads count toward the same project limit. Lowering the limit
does not stop existing work. Each queued thread keeps the model and runtime chosen at enqueue.

As a thread finishes, the queue refills its execution slot while earlier PRs await review or
merge. Approval prompts, user input, post-processing and queued continuations keep the slot.
A queue entry waits when its files overlap an active port or an unmerged port PR; later
non-conflicting entries can proceed. **Start without waiting** overrides that entry's file
wait, while still respecting concurrency and pauses.

Click the queue chip for counts and paginated entries, thread and PR links, file waits, and
reasons needing attention. **Pause** is separate from automatic holds for usage limits,
provider availability, worktree isolation or writer ownership. Holds recheck automatically;
if isolation still cannot create an agent after two minutes, that entry is rejected and
the queue continues. Fix worktree availability and queue those topics again to retry.
Repository contention and temporary preparation errors retain their queued entries and
retry after a short backoff. Direct starts also reserve under the repository lock and
may report that the repository is busy.
Usage recovery respects the existing automatic usage-resume setting. When disabled, the
hold asks you to resume manually and shows no automatic retry time. Recovery never undoes
a user pause. Two consecutive port-thread errors pause the queue until you check the provider
and choose **Resume**. **Clear queue** cancels remaining entries and leaves started threads
running. **Remove from queue** removes selected topics without stopping started work.

Queue drain does not mean topics are Done. Done comes from default-branch evidence, never
just a PR URL or a finished thread. The panel refreshes base evidence at most every two
minutes while review work remains, and shows the evidence time or refresh error.
The queue history remains available after execution stops. A settled turn whose assistant
message is still missing after two minutes finishes as needing attention.

Batch prompts assess every topic individually. Already-present or inapplicable topics report
`UPSTREAM-OUTCOME <topic-id>: equivalent <path:line>[, ...]` or
`UPSTREAM-OUTCOME <topic-id>: not-applicable <one sentence>`, and omit that topic's trailer.
All outcomes form one consecutive block at the end, with per-topic lines before the
thread-level outcome. If all topics are equivalent or inapplicable, only per-topic lines remain.
PR outcome URLs must be HTTPS GitHub pull requests in the repository identified by
the fork's `origin` remote. A missing or non-GitHub origin prevents automatic PR URL
validation; configure origin so the queue can recognize these outcomes.
Credentialed HTTPS and SSH remotes are normalized before repository comparison.
GitHub Enterprise remains unsupported. Pre-feature ports retain display compatibility
with outcome lines followed by explanatory text, and remain excluded from automatic decisions.

## Re-triage and automatic outcomes

**Re-triage failed topics** requires an available triage model. It retries only Inbox topics
with a triage error, keeps every topic's membership intact, and preserves revert-chain
safeguards. A failed or incomplete classification stays eligible for another run. Successful
suggestions replace stale errors; confident rule-approved skips are recorded through the
ledger publisher.

**Record equivalent / not-applicable outcomes automatically** is on by default. A completed,
fully processed turn on its originating active port link can record validated equivalent or
not-applicable decisions as `decidedBy: llm`. Find them with **Automatic only**. Earlier
ports are excluded from automatic recording. Turn messages, evidence paths and fork PR URLs
are validated; unrelated later messages do not count.
For batches, equivalent/not-applicable decisions must name each topic explicitly. Temporary
recording failures retry with persisted backoff, up to five attempts per turn.
The default-branch rules must include
`not-applicable` before that outcome can record automatically. PR outcomes still complete
only through merged trailers; blocked or invalid outcomes need attention. PRs never auto-merge.

## States, trailers and epochs

| State       | Meaning                                                                         |
| ----------- | ------------------------------------------------------------------------------- |
| Inbox       | Waiting for a decision, or a watched topic past its revisit date                |
| Ready       | Marked to port, no active port thread                                           |
| In progress | A port thread for the current epoch is linked                                   |
| Watch       | Waiting for an unfinished upstream series; returns to Inbox after 30 days       |
| Done        | Equivalent already in f5, or a commit on the default branch carries the trailer |
| Skipped     | Skipped or declined                                                             |

A port is done when a commit on the default branch ends with `Upstream-Topic: <id>` (or
`Upstream-Topic: <id>#<epoch>` after a reopen). Port threads add the line to every commit and the
PR description.

Moving a topic back to Inbox or Watch from Port or Done increments its **epoch**. Older trailers
and port threads stop counting, and new upstream follow-ups can join the topic again. Follow-ups
to a topic that is already decided become new topics with a **Related** link instead.

When a port thread finishes, its last line is an outcome: `pr <url>`, `equivalent <path:line>`,
`not-applicable <reason>` or `blocked <reason>`. The detail pane offers **Record equivalent**,
**Record not applicable** and, for a blocked port, **Move to Watch**.

Before you start a port, the dialog warns when newer upstream commits are not triaged yet.
**Run now first** covers them so follow-ups and reverts are grouped before the port starts.

## Policy, rules and the legacy backlog

The ledger lives in `upstream/` by default; `ledgerDir` in the `f5.json` `upstream` block
moves it, and the paths below are then relative to that directory.

- `upstream/policy.md` is free text that both triage and port prompts include. Edit it like any
  other file; it may change together with code. Prompts include up to 16 KiB of it.
- `upstream/rules.json` holds reason keys, path rules that skip commits without the LLM (mobile,
  marketing, CI, docs, tests) and `autoSkipConfidence` (0.85).
- `upstream/archive/schema6.json` is the frozen earlier catch-up. Its deferred records are
  triaged through **Triage legacy backlog**. Records whose implementation commits are already on
  the default branch get an `Equivalent 70%` suggestion you confirm with `a`.
- Never hand-edit `upstream/intervals`, `upstream/legacy` or `upstream/topics`.
  `bun run upstream-ports:check` rejects edits to coverage files and ledger changes mixed with
  code.

## Triage model

Triage runs without tools, MCP servers, slash commands or access to the repository, because
upstream commit text is untrusted. Only Claude instances guarantee that today, so the triage
model picker lists Claude instances only. With **Automatic**, F5 uses the project's text
generation model when it is Claude, otherwise the first enabled Claude instance. **Rules only**
runs without the LLM: every remaining commit becomes its own Inbox topic.

Calibration: one 20-commit batch was not yet measured on a release build. Run
`F5_UPSTREAM_TRIAGE_LIVE=1 node node_modules/vitest/vitest.mjs run apps/server/src/upstreamPorts/triageRun.live.test.ts`
and keep the default batch of 20 unless the median exceeds 90 seconds.

## Publication

Decisions and run results are saved in F5 first, then published to one rolling ledger pull
request. The ledger chip in the header shows its number and unpublished changes; its popover
shows the phase. When publishing pauses, an alert above the lists says why and offers the fix.

| Alert                      | What to do                                                                       |
| -------------------------- | -------------------------------------------------------------------------------- |
| Signed out, push rejected  | Fix credentials or signing, then **Retry publish**                               |
| Closed without merging     | **Re-publish on a new PR**, or **Discard N changes**                             |
| Ledger changed elsewhere   | **Discard unpublished changes and resync**                                       |
| Managed by another profile | **Take over** (the other profile's unpublished changes are then never published) |

A pull request merged while F5 was pushing is detected by content; anything left over is
published on a new branch.

## Good to know

- One F5 profile on one machine writes the ledger for a repository. Other profiles see a
  read-only page with **Take over**. Writers on several machines are not supported.
- Only GitHub upstreams are supported.
- Downgrading after recording new suggestion operations or re-triage runs is unsupported.
  Older builds do not understand those operation kinds.
- The schedule and model choices are personal settings. They are never read from `f5.json`.

## Related

- [Project configuration](../project-configuration.md)
- [Workflows](workflows.md)
- [Scripts: upstream port ledger](../scripts.md#upstream-port-ledger)
