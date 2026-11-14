# Changelog

All notable changes to F5 are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) for the published CLI (`t3`) and the desktop app.

## [Unreleased]

### Fixed

- Pull requests and Usage are back in the sidebar's top navigation, next to Home and Scheduled, with the Pull requests "needs you" badge. In 0.1.9 they moved to the sidebar footer, where they took up no space and could not be seen or clicked. The Pull requests page now shows Settings in the footer again, as it did before 0.1.9; Settings and Usage keep their Back action.

### Changed

- Home is now a triage queue. Threads are grouped into **Needs a decision**, **Ready for review** (failed turns and finished work you have not opened), **Running** (with one row per active workflow) and **Pinned**, and the pane beside the queue shows the selected thread's request, error or last reply without opening it. From that pane you can approve or decline a request, answer a question, implement or revise a plan, resume a paused queue, reply to finished or failed work and queue a message behind a running turn; messages use the thread's own model and modes. `J`/`K` move, `O` opens, `E` settles, `H` snoozes, `P` pins and `R` starts a reply; `Enter` approves once or implements the plan (and opens other threads), `D` declines; `mod+shift+H` opens Home from anywhere. A line above the queue counts pull requests and upstream topics waiting on you and shows the next scheduled run, a usage limit above 50% and low disk space. The greeting, the resume banner, the Recent list and the `mod+1`–`9` project shortcut are gone from Home; recent threads are in the sidebar's Recent view.

## [0.1.9] - 2026-11-14

### Added

- Open a project in the running desktop app with `f5 app [path]` (or `t3 app [path]`). F5 adds or reuses the project, focuses its window, and starts a new thread.
- Preview Word, Excel, PowerPoint, OpenDocument, EPUB, RTF and notebooks in the file viewer, along with fonts, Mermaid diagrams, archives and SQLite databases. HEIC and TIFF images are decoded locally.
- Audio files shared by an agent play inline. Shared files open in the viewer, with a download option for formats without a preview.
- Claude and Antigravity receive supported PDF attachments as native documents, including scanned pages, within size and page budgets that survive restarts.
- Usage includes local Muse Code history, including child sessions and automated reviews. Unknown models remain visible as unpriced and can use custom prices.
- Provider warning and error banners in a thread now have a Refresh button that rechecks the provider and its models.
- **Settings > General** has a **Server health** card. It lists the requests that took a second or longer and the database statements slower than 100 ms since the server started, with how often each happened and its total and worst time, next to the server's memory use and event loop delay.
- Code Review workflows detect the pull request named in the review instructions (a link, or `PR #123` in the project's GitHub repo), open the merged review with a link to it, and can post the merged review to the PR as a comment. Tick **Post merged review to the PR when it finishes** when starting the workflow, or use **Post to PR** on the workflow page. Posted comments end with a footer naming F5 and the reviewer and merge models.
- Upstream ranks every topic in a lane (Security, Bugs, Perf, Features, Maintenance) with a 0–100 score, and the Inbox opens on a shortlist of the topics worth reviewing today. **Expire backlog…** and an optional **Expire after** setting skip unreviewed topics after a while (security topics never expire), **Areas** choose which features reach the shortlist, a weekly notification counts new features, and an opt-in **Auto-port** queues confident high and critical security fixes, and optionally high-impact bug fixes, after each run. Port threads now add a changelog entry for user-visible changes when the repository keeps a changelog. Every profile that opens the ledger must run this version first: the ledger and `upstream/rules.json` use new formats that older versions cannot read.
- Replies show when their turn missed the provider's prompt cache: an amber pill such as "Cache miss · rewrote 118K tokens · idle 3h", with the turn's read, written, uncached and output tokens on hover. The context meter's popup adds the thread's cache history (one bar per turn, click to jump to it), the overall hit rate, and a badge on the ring after a miss. Turn it off with **Show prompt cache misses** in Conversation settings.

### Changed

- Project settings include renaming, reviewed imports of actions from f5.json or t3.json, and a command palette shortcut. Imported actions start with automatic execution off. Settings, Usage and Pull Requests navigation live together in the sidebar footer, with a Back action on those pages.
- Large text, CSV and TSV previews load in a worker and render only visible rows to keep the viewer responsive.
- Thread action menus show icons and sections, with path, branch and thread ID under Copy. Nested menus work with the keyboard in the browser and desktop app.
- Usage labels external session history and legacy unattributed costs as **Usage without a project**. Muse history refreshes incrementally, retains previous data on failure, reconciles cached calls against newly completed turns, and includes priced native calls in cost comparisons.
- Database snapshot history is thinned when the disk runs low: 6 hourly and 3 daily copies with under 10 GB free, and only the newest 2 with under 2 GB free. Thinning starts only when two snapshots in a row find the disk that low, and the server log records what was removed. With more space the history stays at 24 hourly and 7 daily copies.
- New events and commands get time-ordered IDs, so the database rewrites fewer index pages per hour and each snapshot holds less space.
- F5 starts faster and uses less memory on profiles with many archived threads: their activity history now loads when a thread is used, not at startup. The first start after this update takes longer once while two database indexes are built (about 20 seconds on a 6 GB profile).
- The Upstream port queue is now a **Queue** view next to the topic lists instead of a dialog. Jobs are split into **Active** (running first, then queued in order), **Needs you** and **History** (newest first, with cancelled and superseded jobs hidden until you ask). Each job shows its thread title, PR number, when it was queued or finished, and a plain-language result for each topic, and clicking a topic opens it in the detail pane. Waiting jobs list each blocking thread once with its PR, and jobs have actions to start without waiting, remove them from the queue, or retry a failed port. The header chip appears only while ports run or wait, the queue is paused, or something needs attention.
- An expanded workflow in the sidebar groups its steps by phase. A phase with one step shows that step; larger phases fold, and open on their own when they hold the open thread, are running or failed, or have a step waiting on you. Phases that haven't started show faintly. Every step leads with its state (done, running, failed or pending) instead of "Plan Ready", unseen "Completed" or unread bold, and the workflow's PR sits in the implementation step's icon slot so titles line up. A finished workflow's time, its sort order and when it folds into "older" now follow its steps' activity, not background updates that showed weeks-old work as "just now".

### Fixed

- Upstream ports automatically start their code review after a successful continuation, even when an earlier implementation turn was interrupted, failed, or blocked. On upgrade, eligible historical ports are recovered too: each open PR can start a dual-review workflow, so several may start if multiple ports were previously stuck.
- Desktop project activation uses a stable socket address and async canonical path matching. File previews retain access to notebook outputs beyond the live-frame limit and display non-UTF-8 text with a decoding notice.
- The Upstream port queue no longer counts a topic as needing attention after a later attempt ported it, or after you decided it yourself. Running and queued jobs always load first, so they are no longer hidden behind hundreds of finished entries.
- The Usage page counts Pi's cache reads and writes in its token totals and its uncached input. Pi reports cached tokens apart from input, as Claude does, but they were treated as part of input, so totals left them out and uncached input read too low.
- Storage settings count automatic database snapshots at the space they actually hold. Snapshots are copy-on-write clones that share unchanged data with the live database, but each one was counted at the full database size, so nine copies of a 6 GB database showed as 57 GB while holding about 2.5 GB. Recovery backups, Total used and Reclaimable now use an estimate of the data that newer copies do not share, and each snapshot lists both sizes. The amount reported after a reclaim is measured against the snapshots that remain, so removing one from the middle of the history no longer claims space an older copy still holds.
- Reclaiming a database snapshot removes its folder, and an empty leftover folder is reported as removed instead of skipped. Empty snapshot folders left by earlier cleanups are cleared, and no longer count as snapshots for retention or as the copy to restore from.
- Opening a just-created thread waits for its details instead of bouncing to the start page while the sidebar catches up.
- Editor discovery scans PATH directories once per scan, speeding up discovery on slow disks. Desktop preview uses a valid User-Agent and reload shortcuts target the focused page.
- New approvals and questions wait until typing pauses before taking over the composer. Cursor stays in Normal mode unless Fast was selected, and model switches retain saved traits.
- Threads stay Connecting while a turn starts, and checkout PR actions only show the thread branch's PR. The model picker names models unlocked by a CLI update.
- Claude-launched Electron apps open normally, while configured JavaScript Claude entry points still run in the desktop app. Claude gateway and OpenCode usage-limit resets survive turn completion. OpenCode commands with nonzero exits show as failed, ACP retains final messages without a newline, and Muse uses canonical workspace paths and bounded, redacted failure text.
- Commenting on, reviewing and merging pull requests from PR Hub no longer fails with "Comment permissions could not be verified" or "no longer writable": F5 asked GitHub for a permission field that does not exist. Code Review merged reviews now open with a title that links the reviewed PR and follow a consistent layout (target, verdict, severity sections), without the model's narration or a repeated PR header.
- Long agent turns open in bounded history pages, and thread switches and Scroll to end settle at the measured end. Grok runs leading picked skills as native commands. Claude Full access retains approvals when bypass is restricted and retries temporary policy-read failures.
- Project actions can opt into stopping when their thread settles, preserving terminal output. Older pending approvals stay answerable, PR description checkboxes save changes, and Git divergence refreshes after turns even with polling off.
- Silent Antigravity turns stop after 15 minutes without progress. Requests and tools pause the deadline; unobservable subagent batches receive a bounded grace period until the parent resumes. Antigravity continues to reject unsupported Auto mode. Codex reports conversations held by another client, and ACP edits show every file's patch.
- A server started without an auth token answers only requests addressed to `localhost`, a `.localhost` name or a loopback address, so a web page whose hostname is re-pointed at this machine (DNS rebinding) can no longer reach it. A proxy or tunnel that presents another hostname needs `--auth-token`.
- Agents, Git hooks, setup scripts and other processes F5 starts no longer inherit the backend's own auth token (`T3CODE_AUTH_TOKEN`).
- A running turn stores its context-size estimate when it moves by 1% of the context window (at least 2,000 tokens) and when the turn settles, not after every model step. Long turns add far fewer events to the profile database.
- The server log counts recorded worktrees kept for recovery once per start, and Upstream reports a failed pull-request evidence read once per pass, not once per thread.
- Behind a reverse proxy listed with `--trusted-proxy` (`F5_TRUSTED_PROXIES`), the failed-login limit applies to each client the proxy reports in `X-Forwarded-For`, so one client's wrong tokens no longer lock out everyone else. A proxy on the same machine must be listed too (`--trusted-proxy 127.0.0.1`); unlisted, its clients keep sharing one limit. Wrong bearer tokens now count toward their client's limit, and a locked-out client gets `429` with `Retry-After`; requests straight from the same machine stay exempt. `X-Forwarded-Proto` is honored only from a proxy on the same machine or a listed one, so a TLS proxy on another host must now be listed.
- Storage cleanup also removes context-size updates that a later update repeats and planning workflow updates that a newer one replaced, from threads idle for an hour. Threads compacted by an earlier version are visited once more.
- The profile database drops two indexes on its event log that nothing read, which frees their space and makes every event cheaper to store.
- The profile database also drops two indexes on its command receipts that nothing read, so every command the server records writes two fewer index entries.
- The check for queued messages ready to send reads only pending deliveries, not every delivery the profile has recorded.
- Claude's Plan mode instructions name Claude's own tools (AskUserQuestion, ExitPlanMode, the task tools) and no longer warn about an `update_plan` error that only Codex returns. They also say to load ExitPlanMode through ToolSearch when Claude Code defers it.

- Claude command cards retain output when task notifications arrive before tool results and keep streaming output visible while command details load. An offline repair command can recover empty command transcripts from retained provider logs.
- Fast Git commands with explicitly empty standard input no longer fail with a broken pipe.
- On Windows, storage cleanup no longer mistakes a folder that replaced the one you reviewed for the original. Windows file IDs are too large to compare as ordinary numbers, so two different folders could look identical and the newer one could be deleted. F5 now compares the full ID and asks for a rescan.

## [0.1.8] - 2026-11-12

### Added

- Notifications appear at the top right, below the runtime strip, as solid cards with a status-coloured rail and glyph. A command or path shares its line with the toast's buttons. Repeated toasts merge with a count, grouped pull-request alerts list each PR, and errors offer Copy details. Swipe a toast sideways with two fingers to dismiss it.
- A bell in the sidebar title bar opens a notification inbox (⌘⇧L, or Ctrl+Shift+L). Approvals and input requests that still wait on you are pinned under **Needs you**, and All / Needs you / Unread views sit above the list. The header filters by source and turns on Do Not Disturb for an hour, until tomorrow, or until turned off.
- Approval notifications for a single command or file request offer Approve and Deny in the toast and the inbox.
- Notification settings choose in-app, system, sound and inbox delivery per source (threads, pull requests, scheduled runs, upstream, updates, errors) and the toast position. Upstream topics and scheduled runs also show in-app.

### Fixed

- Desktop windows can shrink to 400×360. Settings controls and snooze fields wrap in narrow windows, dialogs clear the native titlebar, and command palettes focus search before submenu navigation buttons.
- Slow desktop backends get three minutes to start before recovery appears. macOS SnapShot skips transparent windows and helper strips, and timestamps respect macOS region/hour preferences and Linux LC_TIME.
- Desktop bundles Electron 44.10.1 for Node and Chromium security fixes. Single-architecture macOS builds omit the other architecture's native prebuilds.
- Cmd+O / Ctrl+O opens the visible file preview in the preferred editor, or the workspace when no file preview is visible. Handled shortcuts no longer launch another editor, and the shortcut works while the terminal is focused.
- Provider updates can take up to 30 minutes without the browser giving up early. Codex instances respect their environment's home directory when switching accounts, including directory names containing whitespace. Agents using ACP now report a disconnected input stream instead of hanging when their process closes stdout but stays alive.
- Git reviews keep tracked edits when untracked discovery fails and retain partial untracked listings when they are too large. Reviews include new files outside sparse-checkout folders, and commit and PR text includes changes outside nested projects. Selected-file commits during a merge now ask you to commit all files. Desktop startup stops waiting for stuck login shells, and safe Windows Git reads avoid starting a console host.
- PR descriptions and comments preserve single newlines on GitHub, Forgejo and Azure DevOps.
- Failed review guides keep retry controls reachable and put provider output in collapsed technical details.
- Claude instances recognize proxy endpoints set in user or managed settings.
- Large PR timelines mount only nearby events while preserving comment drafts and thread disclosures. Narrow panels keep every tab reachable, keyboard navigation focuses the content scroller, and oversized inline confirmations retain accessible controls.
- Local Git status appears before slow PR lookups, without losing sidebar PR badges or accepting another branch's metadata.
- Usage-limit pauses keep tool calls grouped and show the pause separately.
- ID-only ACP approvals retain the original command title and execution kind without mixing tool calls from different sessions.
- Codex sessions recover from failed app-server writes instead of leaving requests hanging, and exit errors include the stderr reason. Claude restores the selected model after a failed live update while preserving it during effort-only changes.
- Provider updates allow the package's install scripts on npm 12, including the postinstall script that installs Grok's updated binary.
- The certification runner's Claude in Chrome check now passes its isolated Claude config to the live run. The live run gains an optional shared-host phase that checks two F5 profiles using Claude in Chrome at once, and its checks now count only calls that actually reach Chrome. The Claude 2.1.317 record is re-certified with that phase passing; F5 doesn't use shared Claude in Chrome yet.
- The certification runner's Claude in Chrome check now passes its isolated Claude config to the live run. The live run gains an optional shared-host phase that checks two F5 profiles using Claude in Chrome at once, and its checks now count only calls that actually reach Chrome. The Claude 2.1.317 record is re-certified with that phase passing.
- Claude threads in different profiles can use Claude in Chrome at the same time with a certified Claude version, instead of one profile's session reporting a conflict or waiting for the other to go idle. Their Chrome calls run one at a time, each waiting up to 20 seconds for the other's; a call waiting for approval doesn't hold the other profile up. Threads in the same profile still take turns.
- An open Claude in Chrome session no longer blocks computer control for every other thread and profile. Other agents can control the computer while it isn't running a Chrome call, and its next Chrome call waits up to 20 seconds for them. Waiting threads say which agent they're waiting for and offer **Stop that agent**. Busy errors name the profile holding control.
- Clicking a desktop notification opens its thread, pull request, scheduled task or upstream project instead of only bringing F5 forward, including after a reload, after closing the window, and from Notification Center. Scheduled-run notices open their thread without reloading the app.
- New worktree threads based on a branch that isn't on the remote no longer finish with a "Fetch base branch" warning. A local base branch with unpushed commits is used as is, instead of starting from the older remote copy; the setup card warns when the local branch has diverged from the remote or the remote can't be reached.
- Preview navigations blocked by a page's leave-page prompt now report a failure, while redirects during loading continue without a navigation error.
- Saving duplicate provider environment variable rows no longer deletes a stored secret that a sensitive row still uses.
- The “New thread in...” palette lists the current project first and labels it “Current”, so pressing Enter starts a thread in the project being viewed.
- Downloaded desktop updates restore the restart prompt after relaunch. Desktop windows support 600px widths, with a sidebar sheet that preserves the content pane's minimum width.
- New project drafts open immediately while the server is offline, using cached settings instead of waiting for reconnection.
- Creating a PR reports success when the follow-up metadata lookup fails.
- Userless SSH remotes resolve to their forge, and profile-authenticated Git refuses them instead of using the machine's SSH identity. GitHub Enterprise PR links can be pasted for checkout.
- PR Hub renders edited and pure file renames, PR watches report conflicts after pushes, and large terminal selections respect attached-file and linked-thread input budgets without dropping context.
- ACP Always allow falls back to the agent's allow-once option. Archived Codex threads can be forked, and late provider refreshes cannot replace status from changed settings.
- PR file-load failures explain forge rate limits and offer Retry, while keeping technical details collapsed. Changed-file actions and selected commits preserve rename and non-ASCII paths in nested projects, including large untracked directories. Claude notices now show why a hook blocked a prompt.
- New project drafts open immediately while the server is offline, using cached settings instead of waiting for reconnection.
- Collapsed diff files defer syntax highlighting until expanded, making large diffs cheaper to scroll.
- Splitting and unsplitting terminals preserves the original terminal, selection, and input focus, while keeping its columns and shell dimensions fitted to the pane.
- Userless SSH remotes resolve to their forge, and profile-authenticated Git refuses them instead of using the machine's SSH identity. GitHub Enterprise PR links can be pasted for checkout.
- PR Hub renders edited and pure file renames, PR watches report conflicts after pushes, and large terminal selections respect attached-file and linked-thread input budgets without dropping context.
- ACP Always allow falls back to the agent's allow-once option. Archived Codex threads can be forked, and late provider refreshes cannot replace status from changed settings.
- PR file-load failures explain forge rate limits and offer Retry, while keeping technical details collapsed. Changed-file actions and selected commits preserve rename and non-ASCII paths in nested projects, including large untracked directories. Claude notices now show why a hook blocked a prompt.
- New project drafts open immediately while the server is offline, using cached settings instead of waiting for reconnection.

- Custom ACP agents, including Copilot, enter native Plan mode and restore their build mode when leaving Plan, including across reconnects. Steering preserves the active turn's mode. GitHub SSH aliases such as github.com-work resolve to github.com for pull requests.

## [0.1.7] - 2026-11-10

### Added

- Claude Fable 5.2 is available in Claude model pickers with Claude Code v2.1.290 or newer. Bare `fable` and `claude-fable` aliases now select 5.2; `fable-5.1` still selects Fable 5.1.
- The Usage page has a Pricing tab for model prices, model mappings and a monthly budget. Activity shows budget meters with a month-end forecast and warns when you're on pace to exceed it.
- Usage tables sort by any column, Projects and threads can be filtered by name, and Activity breakdowns export as CSV.
- Activity can compare usage with the previous period: stat tiles show the change, and the chart marks each bar's previous value.

### Changed

- The Usage page uses one consistent design across its Limits, Activity and Pricing tabs. Limits at a glance is the first block on Activity, and `p` opens Pricing.
- A thread that holds Chrome while idle shows a one-line "Chrome idle" strip with Release instead of the full computer-control card, and the global computer-use pill no longer shows idle Chrome reservations. Release also appears on the full card whenever Chrome is at rest.

### Fixed

- Interrupted first sends preserve draft context through server synchronization and retry recovery. Stalled HEIC previews release image preparation slots after 30 seconds.
- Thread notifications raise their desktop window; worktree branch changes no longer offer unsafe branch restoration.
- Failed first sends retain recoverable drafts, blank provider question descriptions remain answerable, and stopped usage-limited threads stay stopped.
- Stored HEIC images render in attachment previews, and pasted folders become workspace references without discarding question-answer mentions.
- Resuming computer control after "Needs recovery" works for threads that also hold the Chrome lease: Resume now clears native control and Chrome together. A slow foreground press, such as a color swatch closing its popover, no longer counts as an unknown outcome, and unknown outcomes reported by the helper are logged with their AX error code.
- Long OpenCode sessions process assistant updates without rescanning old message parts, and questions preserve their multi-select and custom-answer settings.
- Codex's model picker shows an inherited global Fast tier without overriding project or profile settings when no tier is selected. Explicit Standard choices also apply to one-off prompts.
- Oversized thread-read page requests are clamped to the supported maximum, and registry connections tolerate slower IPv4 handshakes when IPv6 is unreachable.
- Uncommitted Git reviews preserve staged deletions paired into renames. Repositories with a non-origin remote offer Push and Create PR, and branches behind upstream offer Commit for local changes without pushing.
- Web builds reject static chunk import cycles that could otherwise leave the app blank at startup.
- GitLab merge requests show failed child pipelines in PR Hub checks and watches, retain them across discovery polls, and avoid reporting incomplete check reads as passed.
- Large database operations avoid temporary-file I/O that can stall the server, and repeated project favicon requests load faster.
- Reopened terminals no longer replay capability queries that print junk replies at the shell prompt.
- Quote reply handles selections ending at the next timeline row, preserves paragraph and code formatting, and excludes hidden text and response metadata.
- Settings → Archive actions show tooltips and name the thread in deletion confirmations. Row and bulk actions prevent overlapping operations and report failures without leaving controls disabled.
- Server startup restricts the active profile's state directory to owner-only access (0700), including existing custom state directories; if permissions cannot be changed, it logs a warning and continues.
- Popovers overlapping the desktop window header respond to hover and clicks.
- A Claude thread with Claude in Chrome on can take foreground control of other apps while none of its Chrome calls is running, instead of failing with "Chrome is held by another thread". Once it does, its Chrome calls are refused until the turn ends (or, for a takeover, until a background action ends it). Foreground takeover refusals name the thread holding control, and the desktop log records Chrome lease events.
- Codex can hand off Chrome control to native apps without asking the user to stop Chrome. The handoff waits for the browser runtime to exit. New Codex threads can return to Chrome in the same turn with the host's `browser_resume` tool; older provider threads retain next-message restart behavior.
- Interrupted MCP calls and failed foreground handoffs no longer block later Chrome resumes. Parked browsers retain next-message recovery until the host resume tool succeeds, and restore it after a failed resume.
- Queued upstream ports no longer wait indefinitely on files held by an equivalent topic once the port PR that included it has merged. Outcome recovery stops re-reading merged port PRs from GitHub.
- Planning workflows no longer fail a branch or the merge while its plan-format repair turn is starting. If that repair turn cannot start, the stage shows an error with Retry instead of staying in progress with no turn.
- Computer control no longer refuses a foreground takeover with "input-held" while nobody touches the keyboard or mouse. A key or button counts as held only when it was physically pressed and is still down; on macOS, Caps Lock's lock state never counts. A hold stuck in system state stops counting after two minutes without any input. `computer_wait_for_target` timeouts now report a timeout with the blocking reason instead of "Interrupted (turn-ended)", and a pause or policy change during the wait reports its own cause.
- Codex turns that stream bursts of small output chunks are no longer interrupted by notification overflow. Interrupted Codex history with commands, MCP calls or empty reasoning can now be recovered automatically, and the recovery warning stays visible until it is, or until the history is accepted.
- On macOS, computer-control screenshots of apps like Preview are no longer fully masked when one element's accessibility subrole can't be read. Only that element is masked: text fields, text areas and combo boxes are treated as possible password fields, and the elements inside them are still checked.
- The sidebar's nav strip and Projects | Recent toggle stay pinned above the thread list instead of scrolling away with it; the search field stays with them while its results scroll.

## [0.1.6] - 2026-11-08

### Fixed

- On macOS, a stuck synthetic key no longer blocks foreground takeovers in Full access threads while nobody is using the computer. Waiting for the foreground now reports ready only when a takeover can start, and a takeover that times out says why: recent input, held input, or an unhealthy input monitor.

## [0.1.5] - 2026-11-08

### Added

- Computer batches run known steps in one app and stop at the first failure or unconfirmed effect; app-targeted waits can return when the accessibility tree settles.
- Keep Awake has an opt-in "Keep display on" switch that also stops idle display sleep and the idle screen lock while keep-awake is active. It falls back to system-only keep-awake when the lid is closed on the built-in display, the battery is below 20% or unknown, or the Mac runs hot. Outside macOS, where the battery level can't be read, it falls back on battery power.
- Fair waiting for conflicting computer leases and takeover reservations across agents and profiles. Takeover consent appears after control is reserved.
- Shared background apps with serialized writes, fresh inspection after another agent's changes, and press-before-type focus checks.
- App-targeted key and element-scroll interfaces, native process/window delivery, and a real-app rehearsal runner. Background-event app support remains gated: no apps are enabled until their rehearsals pass.
- Saved native computer approvals can include optional foreground takeovers per app in Full access threads.

### Changed

- In Full access threads, mouse or keyboard input during foreground control makes the agent wait and shows an idle countdown. Other foreground threads keep the pause-and-Resume flow.
- "Chrome is busy" errors name the thread holding Chrome (in the same profile) and whether it is working. Idle Chrome holders show in the banner with View and Release, a Chrome-enabled Claude session stops after 10 idle minutes, and a new Chrome-enabled thread takes Chrome from an idle one, whose next message then resumes cold.
- Large commits no longer run a synchronous WAL checkpoint on the database writer. After large bursts the WAL can keep up to 128 MiB on disk instead of 32 MiB.

- Computer performance rehearsals measure verified task effects, report invalid samples and cleanup failures, and require matched fixture and harness identities for comparisons.

- Windows computer use batches accessibility reads, stops element lookup after a match, verifies focus, and defers eligible foreground settling while preserving request deadlines.

- Faster computer actions and macOS inspection, with shorter cursor cues, deferred foreground settling, and smaller clean screenshot responses.

### Fixed

- Windows CLI installs and upgrades no longer fail with `EPERM` when antivirus or the search indexer briefly holds the new runtime folder; the move is retried for up to 10 seconds.
- Writes to a repository's shared Git config start a single Git process per attempt while another writer holds the lock, instead of two.
- Claude in Chrome works in isolated (non-default) F5 profiles on macOS. Their sessions were refused with "Claude in Chrome isn't certified for isolated F5 profiles yet."
- Agent clicks in the desktop preview no longer take focus from the composer, and local sign-in pages that query loopback permissions work in the preview.
- Deleting the open thread no longer opens a settled or snoozed thread next; F5 goes home when no other thread qualifies. Sidebar terminal indicators update per row.
- With appearance set to System on Linux, F5 follows desktop light and dark changes without a restart, including on KDE.
- Workspace content search keeps matches on lines longer than 512 characters and keeps working through slow index refreshes. The Files tree opens symlinked files and folders inside the workspace.
- Terminal selections and their Add to chat menu survive output that doesn't change the selected text, and Add to chat uses the right line numbers after scrolling.
- Composer model picks for a specific provider instance keep their exact model name, including custom names such as `gpt-5.3` that look like built-in aliases.
- Relative file links with routing punctuation, such as `posts.$postId.tsx`, `(group)/[id]/+page.svelte` and `@scope/pkg`, open as workspace files.
- CLIProxy usage works for hubs hosted under a path prefix, and panel URLs such as `https://hub.example/cliproxy/management.html` can be pasted directly.
- macOS foreground computer control no longer pauses in "Needs recovery" after a shortcut that opens a window (such as ⌘N) or a press that closes its own popover. Those actions now report success with `verified: false`, a batch stops after them so the agent observes first, and a shortcut's key-up is always sent. A press that times out still counts as unknown. When control is interrupted, agents see why instead of a bare "Interrupted".

## [0.1.4] - 2026-11-05

### Added

- Cooperative computer use waits for ordinary user contention without a Resume dialog, including foreground control in Full access threads. A wait tool, fresh-observation checks, and a foreground countdown support continuation after you go idle.

- Native computer approvals can persist per project, including app access and session actions, with profile-wide Full access session opt-in. Settings lists and immediately revokes saved permissions; failed saves are shown as lasting until F5 closes.

- Claude in Chrome is certified on macOS on Apple silicon from Claude Code 2.1.317, so it can be turned on.
- A profile can always allow Claude in Chrome taking the browser connection back from your terminal Claude, revocable in Settings → Browser & Computer. Replacing another F5 profile's setup always asks.
- Favorite models can pin an effort, so the same model can be a favorite at several efforts. `Ctrl+1` to `Ctrl+9` in the desktop app switch to favorite N, `Mod+Alt+Right` and `Mod+Alt+Left` cycle through favorites, and `Mod+Alt+Up` and `Mod+Alt+Down` step the effort. "Save current model and effort as favorite" is in the command palette, and `Mod+1` to `Mod+9` pick a row in the open model picker.
- A redesigned sidebar: a nav strip of icon buttons with badges, a project shelf, folded idle threads, workflow rows (finished workflows show their PR state), a Recent view, and peek cards with quick actions.
- Open transcript on agent rows opens a readable, live-updating transcript of a subagent's work in the thread's right panel. Claude transcripts stay readable after the session ends and after a restart.
- Claude in Chrome works in isolated F5 profiles.
- Codex 0.166.0 capabilities: cancellable `/aside` questions with saved answer cards, memory and dollar-usage inspection, account workspace and Vertex AI display, and local feedback bundles.
- Unsent new thread drafts and the New workflow dialog can change their project.
- Project actions are set up in Settings → Project, and a project with no actions no longer shows an Add action button in the chat header.

### Changed

- Interacting with an agent's background app makes it wait until you leave. Explicit Pause, Stop, the stop shortcut, and uncertain outcomes still require confirmed Resume.

- Computer access requests appear in a non-modal panel that leaves F5 interactive and keeps composer focus.
- Closed computer sessions release their permission receipts without requiring a backend disconnect.
- The default Codex switch can select an older version than your current PATH installation and bypass PATH wrappers. To retain a newer CLI or wrapper, configure its absolute Binary path before starting a session. Settings now calls out this migration next to the Binary path field.
- The "Open in browser?" request is a pill at the top of the window instead of a card covering the send button, and full-access threads open links without asking.
- Buttons, inputs and other controls use a quieter tonal style, and command cards use quiet inline actions instead of boxed buttons.
- The computer-use banner says an agent is using Chrome only while a Chrome call runs, and hides another profile's idle Chrome session.
- Removing or resetting a provider asks for confirmation first.
- The in-app update notes show the full release notes, scroll, and link to the GitHub release.

- F5 bundles the audited Codex 0.166.0 runtime. Existing empty or default `codex` Binary paths now use the bundled copy. Set an explicit Binary path to keep a PATH or Homebrew install; isolated profiles still accept custom Codex at or above 0.144.3. Bundled Codex updates with F5. Settings shows bundled/custom runtime sources and a Use bundled reset; isolated Claude profiles keep their bundled-runtime restriction.

- Claude in Chrome certification records are version floors: a Claude update with the same browser setup stays covered, and a changed setup or tool list closes Claude in Chrome with its reason until a new live run. Withdrawing the covering record turns it off, and desktop and server use the same gate.
- The Claude in Chrome live harness observes terminal `claude --chrome` coexistence; permission-mode behaviour, routing isolation, stale native hosts and frozen-server stop are no longer required of the live run.

### Fixed

- Temporary keychain failures no longer replace the consent signing key or erase saved approvals during unrelated writes.
- Windows CLI packaging preserves npm aliases when pinning native dependency overrides.
- Codex questions answered asynchronously show their answers in the Q&A card instead of a raw JSON message.
- Transcripts open for Codex subagents reported only through subagent activity, instead of "session not running".
- Codex filesystem permission requests appear as file read or file change approvals.
- Cancelled ACP tool calls end as failed instead of appearing completed.
- Deleting a thread no longer offers to remove a worktree another thread still uses.
- Pasted Finder or Explorer folder paths resolve to the folder, and settings fields save only after an edit.
- The model picker fits short windows, handles IME input, and keeps the chosen effort across instance fallback.
- Expanded SVG diagrams fit the image viewer, and TypeScript attachments labeled as video preview as text.
- Horizontal scrolling in diff and file viewers no longer switches threads when the viewer remounts.
- Login-shell environment probes that ignore SIGTERM are killed after their timeout instead of blocking startup.
- Antigravity profile preparation no longer fails on stale or missing skill links.
- Git auto-refresh and PR hub polling interval changes save after editing stops.

### Releases

- The release publisher loads its certification checks under plain Node again, with a test that catches imports Node cannot resolve.
- Main CI groups macOS suites into 6 jobs instead of 14, so fewer jobs wait for scarce macOS runners.

## [0.1.3] - 2026-11-03

### Added

- Claude MCP Apps: tools that declare a `ui://` app render it in the chat and can call tools with your approval, as with Codex.
- Analyze usage on Claude usage cards, a Claude sub-agent effort setting, and an opt-in "Confine file edits to the workspace" option per Claude provider.
- The runtime panel shows the observed Claude runtime version and 5-minute versus 1-hour cache writes.
- Keep Awake in desktop settings: Off, While agents are working (with a five-minute cooldown), or Always while F5 is open, plus an optional macOS closed-lid mode with battery and thermal safeguards.
- Hourly profile database snapshots (24 hourly and 7 daily, on by default on APFS), listed under "F5 recovery backups" in Storage settings. If the database is damaged while F5 runs, F5 saves its in-memory state to a recovery file and shows a "Do not quit F5" banner; at startup it refuses to initialize over a damaged database.
- A recovery script rebuilds a profile database from an exported read model.
- The sidebar shows update progress in a status pill: available version, download percent, Restart, Installing and Retry, with a popover for details.
- Storage can reclaim dependency and build folders, more caches, Docker images and a database compaction that never finished.
- Chat links offer Copy Link and Open in integrated browser from their context menu.
- Codex-generated images appear as image replies.
- A profile can always allow Codex Chrome sessions, revocable in Settings → Browser & Computer.

### Changed

- Update the bundled Claude runtime to Claude Code 2.1.317 (Agent SDK 0.3.317), so Sonnet 5.5 and Haiku 5.5 work without an upgrade notice.
- F5's mandatory Claude tool policy now blocks the tool if its check fails or times out (bundled runtime and Claude Code 2.1.317+).
- Dismissed or skipped Claude questions tell Claude which questions went unanswered; Grep/Glob rows note searches stopped at the time limit; cron rows show the next run.
- Claude Opus 4.8 Fast Mode is no longer offered by default (deprecated by Anthropic, removed 2026-11-30).
- The Claude in Chrome certification record for 2.1.295 is withdrawn, superseded by the 2.1.317 record (not yet certified).
- Agent questions render as one Q&A card with the questions and chosen answers. MCP tool-call cards are redesigned and finished calls stay visible after later turns.
- Command cards are redesigned, show the command for backgrounded commands, and derive a header for Codex commands that have no description.
- Mermaid diagrams render while a reply streams.
- The PR hub lists failed and cancelled checks first and groups review threads in the Timeline.
- Background Claude metadata generation (titles and similar) no longer saves throwaway sessions, and Claude subprocesses identify themselves as `t3-code`.

### Performance

- Coalesce rapid tool updates into 50 ms windows, and refresh the branch list when the branch picker opens.

### Fixed

- Attachments and plan files stay readable when a Claude setting blocks reads outside the working directory.
- Warn when Claude cannot save a conversation (disk full or quota), and give the next resume F5's summary.
- Codex Chrome stops driving the browser when a turn is interrupted, keeps working after a pause and resume, and an idle Chrome session no longer reports that an agent is controlling this computer.
- Required unanswered questions block Enter; tapping outside the model picker on touch screens no longer activates the control underneath; up-arrow recall skips automated messages; stale file suggestions and filesystem paths stay out of the composer menus.
- Provider error details redact compound credential values and whole API keys.
- Antigravity question cards keep option IDs, and Antigravity limits merge both quota endpoints so Gemini is not omitted.
- OpenCode retries transient startup locks; Muse quota refusals show Limited and resume at reset; explicit effort reaches uncatalogued Claude models; Claude's rejected Auto fallback is retained for the selected model.
- Ported Pi, Codex, Claude and ACP model fixes, including Pi input placeholders and Codex sessions whose stdout closes without an exit status.
- Cursor usage limits accept `CURSOR_API_KEY` credentials.
- Pi prompts sent during compaction are kept and retried in order.
- A stuck quit no longer leaves the desktop app unkillable; fixes for Hyprland startup and held Cmd/Ctrl+W.
- Diffs containing both a file and a folder of the same name keep both rows navigable.
- MCP apps can enter fullscreen only after user activation inside the app, and thread errors are shown in readable form.
- Renaming a saved sensitive provider variable or clearing its Sensitive checkbox no longer erases the stored value.
- Large workspace file previews no longer stop early on SMB, NFS and sshfs.
- Self-managed GitLab 15.7–17.10 merge request diffs load in the PR hub.
- Queued upstream-port workflows no longer stall with zero running jobs.

### Releases

- Failed or timed-out beta candidate jobs are rerun automatically, up to three attempts, and newer main commits supersede older queued CI runs.
- Publication no longer requires a fresh acceptance report for every build; each certifying record's evidence commit must be in the release tag's history.
- Linux packages no longer grant group or other write access to the installed app.

### Computer use

- Add a Windows x64 computer-use preview with app approvals, foreground and
  background accessibility actions, scoped screenshots and password masking,
  pause/resume, and Ctrl+Alt+Shift+F12 emergency stop. Computer use defaults to enabled
  with background execution on supported desktops; saved preferences and app
  approvals remain in effect. Native workflow, lifecycle and
  capture privacy checks passed on Windows 11; full provider, physical-stop,
  display, Windows 10 and installed-build acceptance remain pending. Signed
  certification remains false.
- Codex Chrome is certified on macOS Apple Silicon.

## [0.1.2] - 2026-11-01

### Added

- Switch providers or provider instances within a thread, carrying a bounded text transcript to the new session and resuming previous sessions when possible.
- Drag threads from the sidebar into the composer to give the agent conversation references it can read on demand.
- Start threads without a project from Home, the sidebar or the command palette, with separate scratch folders for their files, attachments and terminals.
- Show computer and browser-preview runs as session cards with grouped actions, status and screenshots.
- Navigate desktop history with back/forward buttons and macOS trackpad swipes.

### Changed

- Inline HTML replies follow the app theme, support full-screen viewing and zoom, and offer desktop previews and clickable images. Tall replies fit their content up to 20,000 pixels, with clearer feedback when a page cannot be sized safely.

### Performance

- Keep interactive requests responsive by scheduling RPCs by priority, waiting for runtime readiness where required, and reducing startup snapshots.
- Render large changed-files trees with only the rows near the viewport mounted.

### Fixed

- Keep scratch threads' provider sessions, file references, skills, attachments and HTML images in the correct workspace.
- Recover interrupted scratch-folder cleanup and retry failed deletion without removing another thread's files.
- Show image-only messages as images, and keep the internal placeholder prompt out of queues, search results and generated thread titles.
- Keep retained runtime-error details visible in the work log.
- Render Windows file paths correctly in Markdown and preserve line and column when opening filename-only file links in the editor.
- Shut down the desktop backend cleanly when its launcher disappears or its output pipes close.

### Releases

- Build desktop and CLI release candidates once alongside CI, then publish the exact qualified artifacts automatically. Stable preparation PRs record explicit release intent and preserve publication ordering.
- Resume publication without replacing completed assets, transfer components concurrently, retry recognized transient macOS timestamp failures once, and stop obsolete beta builds after newer main commits pass required CI.
- Verify native CLI installation and updates, Windows upgrade preferences and failure recovery, and public release assets and feeds. Release summaries record queue time, retries and artifact reuse.
- macOS desktop packages remain signed and notarized. Windows installers remain unsigned, and existing provider browser/computer certification requirements remain in force.

## [0.1.1] - 2026-10-30

### Installation

- First desktop release for macOS, Windows and Linux, with in-app updates from the GitHub release feed:
  - macOS: Apple Silicon and Intel DMG and ZIP, signed with Developer ID and notarized.
  - Linux: x64 AppImage.
  - Windows: unsigned per-user x64 installer. SmartScreen may warn, and Windows 11 Smart App Control blocks unsigned apps; see the install guide. A later signed release updates unsigned installations in place.
- Releases follow a checked-in desktop profile (`windows` or `all`). Windows-only releases are refused once macOS or Linux updates have shipped. Every release verifies the `SHA256SUMS` contents and the packaged update feed, and must pass a Windows install, upgrade and uninstall rehearsal between two unpublished builds of the release commit. macOS notarization retries submission and stapling when Apple's services drop the connection.
- Fix a Windows update install that could leave F5 unresponsive with no windows: stopping the backend no longer blocks the main process.
- Release builds are titled "F5"; the "Alpha" label is gone, so the app is no longer confused with the legacy F5 (Alpha).
- The Windows CLI archive and `f5 install`/`f5 update` use the Windows `tar`, so installs work when Git Bash or MSYS GNU tar is first on PATH, and the runtime check exits instead of hanging.

- Production desktop updates now use only the public baked GitHub feed; ambient `GH_TOKEN` and `T3CODE_DESKTOP_UPDATE_GITHUB_TOKEN` private-feed overrides are no longer supported.

- F5 now uses its own app identity and imports existing F5 (Alpha) settings once. Screen Recording and Accessibility must be granted again.
- Preview-browser sign-ins may need to be redone because the Chromium cookie key is bound to the old app identity. Backend data under `~/.f5` is unchanged.

### Profiles

- Read Codex account usage through each configured provider instance's home and environment instead of the machine-wide legacy configuration.

- Preserve the real macOS home for managed Claude keychain access while retaining profile-specific Claude configuration and credential entry names.
- Add a Codex device-code sign-in alternative and prevent incomplete or expired login links from being offered by the account panel.

- Allow Codex 0.144.3 and newer in isolated profiles. Versions differing from the audited baseline show an informational notice without disabling sign-in or sessions; managed credential isolation remains required.

- Add separate profile state, provider homes, browser origins and desktop partitions with in-app account setup. Default data remains in place.
- Strip ambient provider credentials for non-default profiles; explicit instance API tokens remain supported.
- Non-default profiles use saved GitHub tokens and managed Git identity; Default retains host Git configuration, SSH, ambient tokens and existing gh logins.
- Preview discovery uses only URLs detected in owned output for all profiles; enter externally started servers manually.
- MCP CLI login times out after nine minutes to leave teardown time within the shared ten-minute OAuth lease.
- Fix Claude instance environments, Windows home overrides, instance model-catalog credentials, configured worktree roots, and explicit-state-dir backup settings/secrets.

### Server performance and storage

- Fix review findings in streaming retry recovery, legacy attachment backup coverage, settings credential redaction, scheduled-backup diagnostics and cleanup, skill watcher recovery, and workflow detail invalidation. Add an independent streaming-batching startup switch.
- Coalesce Codex streaming assistant and reasoning deltas with ordered, idempotent batches and full-text completion recovery.
- Export backups through an owned maintenance process while normal writes continue; protect snapshot attachments from cleanup. Add opt-in daily backups retaining seven successful archives, with credentials excluded. Preserve attachment ownership when restoring into a different state directory.
- Refresh only dirty projects’ skills, preserve unchanged watchers, and show scan diagnostics in project settings.
- Load workflow summaries at startup and fetch full run details when a workflow is opened. Upgrade the wire protocol to 22.

- Fix reliability review findings: persist delivery reservation release across rewind, preserve editor draft identity after saving, admit controls during resynchronization, retry overloaded reads safely, and start offline-mounted terminals once synchronized. Preserve normal umask permissions for new workspace exports.

### Reliability

- Fix Claude threads failing with exit code 126 in packaged desktop builds. Resolve the bundled Claude executable from the unpacked application files while preserving isolated-profile certification, and verify CLI discovery and SDK startup in macOS release builds.
- Keep stop, approvals, user-input answers and supported steering responsive while a provider prompt is pending, and prevent late results from reviving a stopped generation.
- Run durable deliveries independently across threads, scan a bounded rotating backlog, retain delivery reservations, and preserve unknown history as ambiguous recovery evidence.
- Save workspace files with explicit create or hash-match conditions, cross-profile connection-owned locks and atomic installation. Artifact exports never overwrite an existing file.
- Persist revisioned editor draft branches in IndexedDB with explicit recovery choices and concurrent-window discovery.
- Recover terminals with a read-only revisioned snapshot and bounded event replay, preserving clear and lifecycle ordering.
- Reserve separate RPC lanes for stop, answers and recovery, reject overload with retryable busy responses, and bound startup event buffering.
- Keep reading, copying and local drafting available during outages. Server changes resume only after synchronization; reconnect never sends a pending mutation automatically.
- Bump the wire protocol from 20 to 21 for conditional writes, terminal revisions and busy responses.

### Performance

- The sidebar, Home, command palette and inactive chat views no longer re-render on every streamed token of another thread. Timeline rows re-render only when their own content changes, and a row that fails to render shows "This entry could not be displayed" with "Copy error report" while the rest of the timeline keeps working.
- The React Compiler now optimizes the timeline rows, sidebar, Home, command palette results and chat header.
- Components re-render only when the settings they read change, not on every settings write.
- The file browser renders only the rows in view, so large folders scroll smoothly; the "Show more entries" button is gone and revealing a file scrolls straight to it.
- Message bodies of at most 10 inactive threads (32 MiB) stay in memory; older threads reload their latest messages when opened. Drafts, titles and status are always kept. Background prefetching pauses while the threads on screen alone exceed that budget.
- Large code blocks highlight in a background worker. Blocks over 200 KiB or 4,000 lines show as plain text with a "Highlight code" button, and unknown languages show as plain text.
- Open files and visible folders refresh when they change outside F5, including editors' atomic saves, renames and deletes. Unsaved edits get the existing conflict notice instead of being replaced; F5 falls back to polling when the file system cannot be watched. After an agent turn only that workspace's files and listings refresh.

### Added

- Agent and terminal requests to open a browser now appear in a non-modal card in the requesting profile's window, with a native dialog fallback if the card cannot be shown.
- Optional automated code review for Upstream port PRs, with two selectable reviewers, a selectable consolidation model, one queued revision, and review progress and retry actions on each port thread.
- Claude in Chrome lifecycle behind a single certification record (`claude-chrome`, macOS arm64 first, gate closed until a live run is recorded): per-instance readiness with specific reasons, consent for foreign setup, `external-cli-conflict` when a terminal `claude --chrome` takes the connection back, desktop-owned stop that ends the CLI's process group even when the server is frozen, and setup history that can restore the original browser files after restarts and SDK upgrades. `bun run sdk:audit` fails when an advertised record no longer matches the pinned SDK.
- Codex Chrome control (`enableCodexChrome`, off by default, never settable from `f5.json`): ChatGPT for Chrome runs through an F5 MCP proxy that checks every call itself, takes the browser only for the duration of a call, and needs Full access and an isolated Codex home. The proxy forwards only Codex's per-call turn metadata, which ChatGPT's browser runtime requires, and supplies F5's thread identity when Codex sends none. The gate stays closed until the `codex-chrome` record is certified.
- Codex Computer Use (Sky) spike harness through the same proxy; there is no `codex-computer` record, so Codex keeps using F5's computer control. Claude's built-in computer use now explains that the CLI starts it only in interactive terminals.
- Two-phase integration certification: a live run on a clean commit stamps the record (`evidenceCommit`), and a release that embeds a certified record is published only by `bun run release:promote` after an operator acceptance run (`bun run integrations:accept`) of that draft's exact DMG. Codex records now certify a version floor, so newer ChatGPT builds stay open while every signature, origin, inventory and schema check still passes. The Codex Chrome harness also proves that pausing stops background work an earlier call started.
- Error boundaries around each route and each right-panel tab: a failing page or tab shows "Try again" and "Copy error report" in place while the sidebar, composer and other tabs keep working.
- A "Window title" setting in Settings > General chooses whether thread and workflow titles show the project name (default) or the thread or workflow title, which can appear in screen shares and window switchers.
- CI boots the server under Bun (`bun run test:bun-server-boot`) so a Bun-incompatible import fails the build instead of `bun run dev`.

- New "F5 Graphite" default theme with Inter, a cobalt accent, derived faint/attention/chrome tokens, stricter contrast checks, a `text-2xs`/`text-ui` type scale, motion tokens, and a design-token test that rejects raw palette colours, arbitrary text sizes, faded text and pixel radii anywhere in the web app (`apps/web/scripts/codemod-ui-tokens.ts` rewrites most of them). Text inputs no longer default to monospace; path, URL, port and shortcut fields opt in. The default theme keeps its id, so everyone on it gets Graphite, and the interface font changes from DM Sans to Inter; the previous palette stays available as "F5 Black (classic)" in Appearance (its secondary text is slightly lighter to meet WCAG AA). DM Sans is no longer bundled, so an interface or chat font saved as "DM Sans" before this release resets to the default once. The `destructive-foreground` theme token now means red text on ordinary surfaces rather than text on a red fill; a custom theme override that is unreadable on its background (under 4.5:1) is ignored in favour of the generated colour.
- Independent thread summary settings, defaulting new and existing installations to
  Codex/OpenAI with GPT-5.6 Luna and low reasoning effort. Summary inputs (messages,
  activities, plans, tasks, and checkpoints) from **all providers** are sent to the
  selected summary account. Choose a different account/model in Settings > Providers >
  Thread summaries. If that instance is missing, disabled, or deleted, existing notes
  are retained until a working summary instance is selected; no provider fallback occurs.

- Claude Opus 5.5 support across Claude model pickers (requires Claude Code v2.1.280+), with native
  1M context and fast mode, and the bundled runtime upgraded to v2.1.280. Opus 5.5 is now the
  default Claude model and defaults to `medium` effort, matching Claude Code. Bare `opus` and
  `claude-opus` aliases now select 5.5; `opus-5` remains pinned to Opus 5. Older custom CLIs omit
  5.5 from pickers and fall back to the first supported built-in, which is Opus 5 on v2.1.220
  through v2.1.279. Isolated profiles now certify Agent SDK 0.3.280. Persisted bare aliases in
  threads or sub-agent overrides may fail at runtime; select a supported model or upgrade the
  executable to recover.

- Claude Fable 5.1 support across Claude model pickers (requires Claude Code v2.1.257+),
  with native 1M context and the bundled runtime upgraded to v2.1.261.
  Bare `fable` and `claude-fable` aliases now select 5.1; `fable-5` remains pinned to 5.
  Older custom CLIs omit 5.1 from pickers. Persisted bare aliases in threads or sub-agent
  overrides may fail at runtime; select a supported model or upgrade the executable to recover.
  Fable 5's default effort is now `high` (previously `max`); explicit effort is preserved.
  Auxiliary Claude generation now preserves `xhigh` and applies the `ultrathink` prompt prefix.
- GPT-6.1 Sol and GPT-6 Astra support across Codex model pickers; GPT-6.1 Sol is the Codex
  default and both require Codex CLI 0.153.0+. New `6.1` and `gpt-6.1` aliases select
  GPT-6.1 Sol. Astra caps reasoning at Max; GPT-6.1 Sol keeps every effort through Ultra.
  Older CLIs may reject these models when opening a thread or sending a turn; select another model
  or upgrade Codex to recover.
- Four runtime safety modes: Supervised, Auto-accept edits, Codex Auto review, and Full access,
  with provider-specific capability gating.
- Durable per-thread next-turn queues with pause/resume, editing, reordering, run-now,
  duplication, retry, bulk clear/undo, queue badges, keyboard shortcuts, and queue visibility
  outside the active thread.
- Crash-replayed provider turn delivery with Recheck/Retry/Discard recovery, durable
  turn-processing quiescence, and explicit attachment ownership/cleanup records.
- Claude Opus 5 support as the new Claude default (custom Claude binaries require Claude Code
  v2.1.220+).
- Claude Fable 5 support (requires Claude Code v2.1.170+).
- Add Claude Opus 4.8 to the Claude provider model list.
- `NOTICE.md`, `ARCHITECTURE.md` (root stub), `SECURITY.md`, `CODE_OF_CONDUCT.md`, and `THIRD_PARTY_LICENSES.md` at the repository root.
- `docs/provider-prerequisites.md` covering both Codex and Claude Code install/auth.
- Documentation index at `docs/README.md`.
- `bun run screenshots:capture` regenerates the README and marketing screenshots from seeded demo data in an isolated temp root.
- Drift test (`scripts/env-docs-drift.test.ts`) checking that every `F5_*`/`T3CODE_*` variable in `turbo.json` `globalEnv` is documented in `docs/environment.md`.
- Server-authoritative thread pins and snoozes with global pin ordering, durable expiry, wake
  predicates, and one-time migration of legacy browser-local pins.
- Race-safe thread title regeneration using current conversation context, correlated requests,
  title provenance/revisions, and stale-result protection for manual renames and newer requests.
- Per-project workspace defaults and manual icons, plus safe checked-in `f5.json` configuration for
  non-executable workspace and icon fields (`t3.json` is accepted read-only for interoperability).
- Thread activity tail reads return at most the newest 500 rows, with explicit null-safe cursor
  pages for loading older durable work-log entries without materializing the full activity history
  on thread open.
- Thread history now loads one bounded page when the virtualized timeline reaches its top, keeps
  the visible viewport anchored across prepends, and can hydrate unloaded message deep links with
  server-resolved anchor and forward cursors across adjacent timeline streams.
- An Agents right-panel surface groups durable workflow and direct-subagent work, shows live counts,
  and links each entry back to its source timeline activity across threads and restarts.
- A Usage dashboard reports provider-supplied tokens and API-equivalent cost over 24-hour, 7-day,
  30-day, and 90-day ranges. New turn facts are captured at provider-event ingestion, historical
  event-log costs remain visible with explicit partial-coverage diagnostics, and missing prices are
  shown as unreported rather than estimated or treated as zero.
- Pull-request identity, authentication state, capabilities, and provider-native metadata now pass
  through a provider-neutral source-control seam. GitHub behavior is preserved, unsupported
  providers fail closed, and repository discovery considers every configured Git remote.
- GitHub and GitHub Enterprise pull requests now expose in-app Summary, Timeline, and Files tabs,
  including cached failure-tolerant reads, comment edits, reactions, reviewer changes, and branch
  updates gated by provider capabilities and account permissions.
- A dedicated Appearance category now provides validated interface, chat, code, and terminal font
  controls. Changes apply live across app chrome, messages, the composer, diffs, previews, and
  xterm terminals, which refit without restarting their sessions.
- A local theme library now separates light/dark/system mode from color palettes, applies themes
  before first paint, generates accessible OKLCH palettes, and supports bounded custom-theme
  editing, export, and file-drop import from F5 JSON, VS Code JSON/JSONC, or VSIX files.
- Desktop previews now retain a bounded recent-site history, show validated same-origin page
  favicons and titles in panel tabs, persist color-scheme and viewport/aspect preferences, and list
  only local development servers that answer a bounded readiness probe.
- Session failures now carry stable server-generated identities and occurrence times, so dismissing
  an error survives reconnects while a later failure with identical text remains visible.

### Fixed

- `scripts/run-demo.ts` no longer deletes a caller-chosen directory or inherits provider credentials.
- Telemetry is off unless `T3CODE_POSTHOG_KEY` is set. Builds without a key no longer create an anonymous id, open an HTTP client or send heartbeats.
- Streaming assistant replies no longer re-read every message in the thread for each delta; the projection reads only the affected row, so long threads stay responsive while a reply streams. A message row owned by another thread is never overwritten.
- Code blocks no longer crash with a React hook-order error when a highlighted block is shown again from cache, and two different code blocks can no longer share a cached highlight.
- The marketing site's download buttons and repository links point at F5 releases (`lopes-felipe/f5`, overridable with `F5_RELEASE_REPOSITORY` at build time) instead of upstream T3 Code; corrupt or failed release lookups are handled instead of showing broken links.
- The once-a-second elapsed-time clock no longer re-renders the whole chat timeline; only the live "working" label and running command cards update, and a command left running on an idle thread stops counting.
- Code-review and investigation workflow stages complete only with the turn they dispatched. A stale or user-started turn on a reused stage thread can no longer stand in for the stage's own output, and a stage whose provider confirms delivery only after the turn finishes (or across a restart) still completes. Stages started before this release keep the previous rule. Planning workflows are not yet covered.
- The desktop app's backend crash budget resets after a minute of healthy running, so isolated crashes days apart no longer exhaust restarts; restarts back off exponentially up to 10 seconds.
- Typing in the composer no longer serializes every thread's draft on each keystroke; drafts are serialized once when the debounced write runs.
- Native window and browser tab titles follow the current page (Usage, Pull Requests, Settings, or the project or thread of the open thread or workflow), with the profile name appended outside the default profile, instead of a fixed app name.
- Sending a message while scrolled up follows the new turn to the bottom when it starts a new turn; steering a running turn leaves your scroll position alone.
- The workflow run inspector loads only when expanded, refreshes when the run changes, and shows a retryable error instead of an empty panel.
- Screen readers announce each approval or question that needs you (including several in one turn) and announce a turn's outcome ("Response ready", "Response failed" or "Response stopped") once, instead of a generic or repeated status.
- `bun run dev` starts the server again; Bun-incompatible `node:sqlite` imports are loaded lazily per runtime.

- Claude turn costs are no longer over-counted. The Agent SDK reports a running total per session,
  which F5 was adding to workflow budgets and usage reporting on every turn, so a long thread could
  hit its cost limit far below actual spend. Turns now report deltas. Resumes remain compatible
  with older custom CLIs without requiring the experimental usage RPC. Resume cursors now retain
  the last observed total so model, effort, and idle-session restarts preserve cost accounting.
  Older cursors without a baseline and native-log repairs still leave costs unreported. Zeroed
  crash placeholders remain unpriced. Reset inference and missing baselines can under-count spend.

- Clarifying questions asked during a workflow's merge or revision stage no longer fail the turn.
  Those stages ran as `unattended-readonly`, so a question was treated as a profile violation that
  interrupted the turn and discarded its work, while the model was simultaneously being told by
  plan-mode instructions to ask questions. `merge` and `revision` are now `attended-readonly`: the
  question is surfaced and the workflow waits for an answer. Fan-out reviewer stages stay
  unattended, but a question there is now recoverable — the request is auto-declined with guidance
  to pick and document a conservative default instead of killing the turn — and the workflow
  host contract is placed after the collaboration-mode block so it can override plan mode's
  instruction to ask questions.

### Changed

- The rest of the web app now uses the same type scale and semantic colours: diff, file, plan and agent panels, the command transcript (its shell syntax colours follow the theme), pending questions, onboarding checks, Pull Requests, Usage and profiles. Every control without its own focus style shows a theme-coloured keyboard focus ring, and custom provider instances are marked with an accent dot instead of tiny initials.
- Settings navigation is grouped (App, Interface, Agents, Data, About) with an icon per page, and every page uses the same cards with divided rows instead of boxed rows. A keyboard shortcuts reference opens with `Mod+/` (the new `help.shortcuts` command), from a button next to Settings in the sidebar footer, or from the command palette; it lists your current bindings by area and can be filtered. The palette adds "Go to Home", and "New thread in ..." targets your most recent project when no thread is open. Pull Requests and Usage show their name in the title bar (the Pull Requests view toggle and refresh actions now sit there), the no-thread screen uses the standard empty state, and the startup skeletons match the new thread and workflow layouts.
- The New Workflow dialog is wider with two columns: workflow types as cards with an icon and a one-line description next to the prompt, and each model on one compact row beside it. Own-model review, plans directory, compare branch and the cost limit sit in a collapsed Options section that summarises the current choices. The implement dialog uses the same model row and Options.
- Workflow pages share one layout: a title bar (project, workflow type, status, close), a title with status, cost, run time and project, then the steps as a board of phase columns on wide screens (a list below `lg`), and below them failed steps, the produced plan, document, review or analysis, the collapsible requirement and the run inspector. Each step shows its role, status and model (the configured model until its thread exists) and, while running, what its thread is doing. "Back to chat" is replaced by the close button.
- Home is a dashboard: a greeting and a quick-start card (project picker, "New workflow", "Add project", and Start, which opens a new thread with your text in its composer and focused, never sent), then Pinned, a "Needs you" grid of cards with one action each (Review plan, Answer, Review approval; the first eight show, with "Show more" for the rest, and workflow steps waiting on an approval, an answer or a paused queue are included), Working and Recent rows without idle chips. The stat strip and the old header are gone, and the onboarding panel and startup skeleton use the same flat styling.
- The composer floats as a dock over the end of the conversation (the last message always scrolls clear of it), with a tray on its top edge for thread notices (at most two, then "N more notices"; the thread error, pending-send recovery and provider health banners move here from under the header), worktree setup, the turn queue, agent questions and rewind drafts. Its footer has an Add menu, quiet model, traits and access chips, an Agent/Plan switch, a "Plan panel" toggle, and a context-window ring that replaces the header token badges; provider runtime details are a one-line strip under the header and the branch line is a single quiet row.
- The chat composer takes grouped props (pending interaction, model, mode, send and attachment controls) and its footer controls and primary action live in their own `composer/` modules. No visual or behavioural change.
- Conversation reading: a Conversation width setting (narrow, comfortable, wide); quieter user bubbles and assistant actions in a footer row; file references share one chip style; work logs from finished turns collapse to a one-line summary when the next turn starts (Collapse finished work logs, on by default and off in the Detailed profile); the working row shows the current activity; a richer empty thread state; and "Jump to latest" marks new content while scrolled away.
- Thread header is a breadcrumb (project, workflow, title, status) with a Files/Diff/Agents/Terminal toggle group that folds into a Panels menu when narrow; the inline right panel is its own canvas with quieter tabs; multiple terminals use a top tab strip instead of a side list, and the drawer gains a Hide terminal action.
- New canvas shell: the content area is a raised rounded canvas inside the sidebar chrome, every route shares one title bar (Electron drag region, sidebar toggle when collapsed), and the sidebar is redesigned with New thread/New workflow actions, a "Needs you" section, quieter project and thread rows, phase-labelled workflow threads with model chips, and in-row archive actions.
- The sidebar is split into `components/sidebar/` modules (brand header, nav, add-project form, project and workflow items, one shared thread row, and thread-action hooks) with a shared per-thread status map. No visual or behavioural change.
- Implementation-planning workflows now require an explicit plan submission, including v1 runs
  already in progress. Unwrapped assistant text and changed Markdown files are no longer captured
  as plans. Missing submissions receive one format-repair attempt before the stage reports an error.
  Previously saved plans and document workflows are unchanged.

- PR Hub keys are now provider-qualified (for example, `github:github.com/owner/repo#123`). Existing
  GitHub rows are migrated automatically, and legacy unqualified command keys remain accepted.

- **Breaking:** `RuntimeMode` now includes `auto-accept-edits` and `auto`. Older clients reject
  threads, queued turns, or events carrying either literal cleanly and must be upgraded before
  using those modes.
- **Breaking:** the old `nextTurnQueue.enqueue` and `nextTurnQueue.resume` WebSocket methods were
  replaced by server-owned `nextTurnQueue.submit`, `nextTurnQueue.setPaused`, and the expanded
  queue mutation API. Established-thread sends now always pass through durable admission.
- **Breaking:** removed the unused `orchestration.replayEvents` WebSocket RPC. Clients must use
  bounded startup snapshots, thread tails, and history-page APIs instead of requesting the full
  event log in one response.
- **Breaking:** pin and snooze lifecycle commands add new orchestration domain-event variants.
  Clients must be upgraded before using these actions; existing snapshots remain decodable through
  optional/defaulted thread fields.
- **Breaking:** title regeneration adds new orchestration domain-event variants. Existing thread
  snapshots remain decodable through optional/defaulted title-state fields.
- Correct Claude Fast Mode availability: enabled for Opus 5 and Opus 4.8, and disabled for Opus
  4.7, 4.6, and 4.5.
- **Breaking:** the web server now binds to `127.0.0.1` by default. Remote deployments must set an
  explicit non-loopback `--host`, use an authentication token of at least 24 bytes, and provide
  encrypted transport through a private network or HTTPS/WSS reverse proxy.
- README rewritten for the current feature set (seven providers, four workflow types, thread workspace, PR hub, usage) with regenerated screenshots, plus new workflow, thread and agent-tool guides and a docs index.
- `CONTRIBUTING.md` restructured so "how to run / test / ship" appears before the triage policy.
- `AGENTS.md` adds a Repository map section and now mentions both Codex and Claude Code.
- `docs/release.md` updated to reference the `lopes-felipe/f5` repo and document the legacy `t3`/`T3CODE_*` identifier policy.
- Stale docs under `docs/` (formerly `.docs/`) rewritten to name F5 and both providers (Codex + Claude Code).

### Moved

- Internal `.docs/` directory promoted to `docs/` so GitHub renders it in the repository sidebar.

---

The first public release will populate this file with a `vX.Y.Z — YYYY-MM-DD` section and begin tagging entries accordingly.
