# Changelog

All notable changes to F5 are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) for the published CLI (`t3`) and the desktop app.

Unreleased entries now live as one file each under [`changes/`](changes/README.md), and each stable release folds them into its section here. Run `bun run changelog:preview` to see what the next release will list.

## [Unreleased]

## [0.1.12] - 2026-11-26

### Added

- Codex hooks that need approval after a plugin changed are marked "Needs approval" in Settings →
  Providers → Hooks, plugins and connectors, with Trust and Trust all buttons that approve the
  contents shown, through Codex. Hooks that changed again before you confirm are not trusted. If
  Codex cannot save the approval (for example because `config.toml` breaks an administrator
  requirement), its error appears next to the hooks. Conversations that are already running pick
  up the approval when their Codex session restarts.
- A turn's "hook approval required" failures now show as one warning row naming the changed
  plugins, with a link to review those hooks for the conversation's provider and project, instead
  of one red card per hook.
- Workflows can run with more than two actors: up to 4 authors, document authors or
  investigators, and up to 6 reviewers for code review and upstream port review. With three or
  more authors or investigators, each one cross-reviews every other one's work. At most 4 review
  turns run at once, and the dialog shows how many turns the workflow will start, including the
  reader review and polish of a Document workflow.
- The workflow dialog can't start a run whose merge, synthesis or consolidation model, or enabled
  Document reader model, is on a provider that can't run read-only workflow turns; the row says
  why.
- Document authors and investigators each need a different model. Long reviews and
  investigations are excerpted fairly when the consolidation, synthesis or (with three or more
  authors) revision prompt would be too long, and each excerpt is marked as shortened.
- Antigravity can run read-only workflow turns on versions F5 has certified: workflow turns run in
  Plan with Supervised access, and edits, commands, computer use and MCP tools are denied. No
  version is certified yet, so Antigravity stays unavailable for review and document stages.
- PR Hub can delete the source branch of a closed or merged GitLab merge request when GitLab permits it and the branch still points to the reviewed commit.
- Usage can include OpenCode and Antigravity history from local stores and Cursor account history from your CLI login. Enable the sources under Usage → Pricing.
- Right-click a draft thread in the sidebar or press Shift+F10 to copy its path or branch, open project settings, or discard it with Undo.
- Usage shows cost by token type and speed, with details for each model. Enable model list prices to estimate costs when the provider omits them.
- Setting `DO_NOT_TRACK=1` stops F5's background requests: automatic provider CLI update lookups,
  the remote model manifest and file icons from jsDelivr (icons are drawn locally instead).
  Update checks you start still run. On macOS the desktop app also picks up `DO_NOT_TRACK` from
  your login shell.
- Added `f5 doctor` (`--json` and `--bundle <path>`) CLI command and matching **System health check (Doctor)** card in Settings → General with one-click redacted support bundle export.
- Improved Settings search to match category names, `F5_*` environment variables, and all built-in providers (`antigravity`, `pi`, `acp`), added result descriptions, a `/` shortcut hint, screen-reader result counts, and keyboard arrow navigation across settings categories.

### Changed

- Pull request diffs follow the changed-file tree order. The pull request and chat diff panels share a Hide test files toggle.
- Text generation through OpenCode defaults to Big Pickle when you choose OpenCode without specifying a model.
- F5 exports traces and metrics only to the OTLP collector set in **Settings → Diagnostics**.
  `OTEL_EXPORTER_OTLP_*` endpoints and headers from the environment are now ignored, so a
  workstation-wide collector no longer receives F5 data; F5 logs a warning at startup when they
  are set. `OTEL_RESOURCE_ATTRIBUTES` still labels exported data, for example to replace the
  host name.
- Agents now start with `DISABLE_ERROR_REPORTING=1`, opting Claude Code and other CLIs that honor
  it out of vendor crash reports. A value in your environment or a provider instance's
  **Environment** setting still wins. Terminals and git are unchanged.
- On Windows, terminal activity and storage checks now ask Windows only for the process details
  they use, rather than every process's full command line.
- New side chat and existing side chats in the composer's + menu show icons.
- Compact conversation is available from the + menu when the composer is wide, not only from the
  compact composer's controls menu.
- A scroll-collapsed composer stays open while an attachment notice or failed upload needs your
  attention, and expanding its attachments from the keyboard keeps focus in the composer.
- Added first-class `F5_*` server and build environment variables (`F5_MODE`, `F5_PORT`, `F5_HOST`, `F5_NO_BROWSER`, `F5_AUTH_TOKEN`, `F5_LOG_WS_EVENTS`, `F5_LOG_THREAD_OPEN_TIMINGS`, `F5_LOG_PROJECTION_TIMINGS`, `F5_OBSERVABILITY_ENABLED`, `F5_WEB_SOURCEMAP`) while retaining `T3CODE_*` aliases as automatic fallbacks.
- Migrated theme, Agents panel, model preferences, terminal state, and notification-prompt browser storage keys to the `f5:*` namespace with silent one-way fallback from legacy `t3code:*` keys.
- Read-only workflow stages can read pull requests, CI logs, review guides and repository files
  through F5's forge tools on Codex, Claude, Cursor, Antigravity and Pi. Write tools such as
  merge, review and re-run stay out of those stages, including on Pi. The new `repository_file_read` tool
  reads a file or lists a directory at a branch, commit or PR head on GitHub. These reads also work
  when the stage's folder holds several repositories, as long as the PR's host has a connected
  account.
- Each read-only stage's thread records how it is kept read-only: sandboxed, or policy-enforced.
- Antigravity read-only workflow stages launch in Antigravity's OS sandbox, so where the sandbox
  can start their shell commands have no network and can't write outside the workspace.
  Certification now covers a minimum Antigravity version per platform, so F5's automatic
  Antigravity updates keep certified workflows available. Antigravity 1.5.15 and later is
  certified on Apple silicon Macs, so it can run workflow reviews, investigations and document
  stages there.
- Refreshed the F5 marketing site with the Graphite + Cobalt palette, real product screenshots, the full provider matrix (8 built-in providers plus custom ACP agents), and fixed Linux download detection on the landing page.
- Read-only workflow stages on Cursor and Antigravity accept `if`/`elif`/`else` blocks, `{ …; }`
  groups and `( … )` subshells when every command inside only reads, such as
  `if [ -d repo/.git ]; then git -C repo status; else echo "No repo"; fi`. Loops, `case` and
  functions are still refused. Their commands also run with `GIT_OPTIONAL_LOCKS=0`, so an
  approved `git status` no longer rewrites the index or holds `index.lock`.
- The model picker opens on one list: your three most recent models, then Favorites, then every
  provider's models. Chips under the search field narrow the list to Favorites or one provider
  (`mod+shift+↑/↓` cycles them), and search stays inside the chosen chip. Each model takes one
  line with its slug, older models fold under a "Legacy" row per provider, and `mod+1` to
  `mod+9` always pick your favorites in order.
- The composer's Access menu is a compact autonomy ladder: one line per mode, from Full access at
  the top to Supervised at the bottom, with a coloured bar filled up to the current mode and a short
  tag on each row. Highlighting a row previews its fill, and a caption under the rows describes
  that mode. Modes the provider doesn't support stay listed as Unavailable, and the caption says
  why. Opening the menu from the keyboard starts on the current mode.
- Access modes use the same names everywhere: "Auto-accept edits" is now "Accept edits", and
  Settings shows "Supervised" instead of "Ask for approval".
- F5 has a new app icon: the name drawn as five coloured lines.
- Upgraded `@legendapp/list` from prerelease `3.0.0-beta.44` to stable `3.7.3` across all virtualized web lists (message timeline, command palette, file browser, workspace picker, PR Hub, upstream topic list, model picker, and agent transcript).

### Performance

- Queued messages in projects with many repositories are sent sooner after a turn ends:
  repositories that did not change are no longer re-scanned for the turn's checkpoint.
- Inactive preview tabs stop painting between browser automation and recording operations.
- Graduated React Compiler in `apps/web` from `annotation` mode to `infer` mode across production web sources so React components and hooks receive automatic memoization without manual `"use memo"` directives.
- Fixed three Rules-of-React / mutable-module-global reads uncovered during full browser verification: opted the preloaded inline-diff Suspense shims in `MessagesTimeline` out of memoization (`"use no memo"`), subscribed `PrLinkedPanel` to `prHubAccount` via `useSyncExternalStore`, and moved Home composer `chosenEnvMode` into Zustand (`useHomeComposerTextStore`).

### Removed

- F5 no longer contains product analytics. The dormant usage telemetry inherited from T3 Code,
  its anonymous ID and its startup heartbeat are gone, and F5 deletes the leftover `anonymous-id`
  and heartbeat lock files on startup. [Privacy](docs/privacy.md) lists every request F5 still
  makes on its own.

### Fixed

- Expanded command cards highlight more file reads and searches:
  - `git show <rev>:<path>` reads, including ones narrowed with `sed -n` or `head`.
  - `git grep -n` results.
  - Commands that chain several reads and searches. Each read becomes its own highlighted file
    block, results are grouped by file, and output from other commands in the chain stays plain
    text. Before, one unrecognized command made the whole output plain.
- Choosing a reasoning effort for an Antigravity model, or a thinking level for Pi or Muse, now
  takes effect. Before, the menu stayed on the model's default and the turn ran at that level.
- Antigravity, Pi and Muse are kept as the last-used provider, in recent models and in favorites
  after F5 reloads.
- An experimental Linux VM profile's window no longer stops at "Profile changed" once its VM is
  up: the backend in the VM now reports the profile it serves. Profiles can't be created,
  changed or deleted from inside a VM profile; its window says so and disables those controls.
  Manage profiles from a host profile.
- Expanded command cards highlight more agent commands:
  - Searches over a file from another revision or piped from a read, such as
    `git show main:a.ts | grep -n x` or `sed -n 40,80p a.ts | grep -n x`, are grouped under that
    file with its real line numbers.
  - Chains that print labels or counts (`echo "== x"`, `wc -l a.ts`) keep highlighting the reads and
    searches around them.
  - Commands that use shell variables (`H=abc123; git show ${H}:a.ts`) or `|| true` are followed.
  - Reads of a file written earlier in the same command show the original file's name, as in
    `git show A:a.ts > /tmp/a.ts` followed by `sed -n 1,9p /tmp/a.ts`.
  - A whole-file read followed by a search (`cat a.ts; grep -rn x src`), a search that finds
    nothing in the middle of a chain, and patterns with escaped backticks or `$` no longer turn
    the rest of the output plain.
  - One command the card cannot follow, such as `a || b`, no longer turns the output before it
    plain.
- The Cursor model picker now lists the models your Cursor account can use, with their effort,
  context and fast-mode options. Choosing Auto works again on current Cursor CLIs.
- Antigravity edits now show their own file and an exact diff. Before, every edit row listed all
  of the turn's changed files, showed the same diff and read "0 files".
- An Antigravity thread left idle for about 30 minutes no longer loses its next reply and shows
  "Provider output is incomplete" again after every message.
- Antigravity file writes now show their diff, including new files, which Antigravity always marks as overwrites.
- Antigravity edits in the latest turn no longer appear twice, once while running and once completed.
- Pasting a thread link uses the current selection in the composer, even when the cursor has just moved.
- The Forgejo and Gitea reviewer picker loads the full list of eligible reviewers, including read-only collaborators where the forge supports reviewer lookup. It excludes the pull request author.
- Open PDF previews keep their reading position while the agent works and while the preview URL renews. Editing the PDF refreshes the preview, and removing it shows that the file is unavailable.
- Changing provider settings still triggers a fresh check after a previous check failed.
- Automatic worktree cleanup keeps checkouts for threads waiting to resume after a usage limit.
- OpenCode shows the provider’s payment error when an account is out of funds, without treating it as a temporary usage limit.
- OpenCode sessions and generated text authenticate to password-protected servers, including local servers with a custom username. A missing stored password is reported before F5 starts or connects to the server.
- Short-lived Pi discovery and text-generation processes skip the startup catalog refresh that could lose a rotated OAuth token.
- Pi status identifies the default model and provider when that provider has no available models. Supported Pi versions can confirm whether credentials are missing.
- Pi status warns when discovery finds no usable models.
- Stopping a Pi turn clears queued native messages on supported Pi versions and shows how many were cleared.
- GitHub requests, including code review posts, recover on their own a minute or so after GitHub
  briefly rejects a valid token, instead of failing with "The GitHub credential was rejected"
  until F5 restarts.
- Enable **Follow worktree branch switches** in Git settings to update a conversation’s recorded branch after an external checkout. The setting is off by default.
- GitLab inline review threads now show as outdated when their diff revision differs from the merge request’s current revision.
- Unresolved GitLab overview discussions now appear as review findings in PR Hub.
- GitLab merge requests show head pipeline status in PR Hub, and review filters can find requests with changes requested.
- GitLab pull request watches now react when a comment is edited in place. Resolving a discussion no longer counts as a comment edit.
- A branch tracking another local branch no longer displays that branch’s pull request.
- Generated pull request titles and descriptions stay focused on the code changes when the supplied context includes follow-up requests.
- Thread CLI help identifies the remote default branch as the base to pass for independent worktrees.
- Opening a work group with earlier activity fetches a bounded page. Load earlier keeps paging until it reaches an earlier user message or the end of message history.
- Brief WebSocket connection attempts and reconnects no longer flash a connection warning.
- Earlier chat work remains visible as you page back, and hidden previews retain their active viewport.
- Usage retains complete history after a partial scan and clears Cursor history when the login changes or becomes unavailable.
- Losing internet access no longer shows a disconnect warning while the local F5 server remains reachable.
- Drafts stay available while attachments are preparing, and Usage opens while list prices refresh.
- An Antigravity turn that hits the account quota now shows the usage-limit notice with its reset
  time and can schedule "continue" for after the reset, as Codex and Claude turns do. Before, it
  showed a generic "Antigravity stopped this turn because of an error", or completed silently.
- The workflow model pickers (New Workflow, Implement and upstream port review) now use the same
  model picker and effort controls as the chat composer. Antigravity models are listed instead of
  "No models found": in New Workflow and port review they stay disabled with "Read-only workflow
  turns are not certified for this Antigravity version" until a version is certified, and the
  Implement dialog can pick them. Codex Fast Mode stays available in workflow slots. Workflow slots
  leave out traits a workflow turn can't use: Claude Ultrathink and Ultracode, and OpenCode and
  Muse traits, which workflow turns never apply.
- The model picker's search moves through results with the arrow keys and skips models that can't
  be picked, so Enter picks the highlighted model rather than always the first result.
- Copy and Save work for images embedded as data URLs.
- New threads recover when the conversation loads before the server has saved the thread.
- Checking out a fork pull request looks up the fork on the pull request's host.
- Ctrl+Left and Ctrl+Right in the terminal send the shell's modified arrow keys on Windows and Linux.
- Expanding a collapsed work log near the bottom of a conversation keeps the heading in view.
- The Antigravity CLI no longer updates itself behind F5's back; F5 now disables its
  auto-update with the value the CLI actually accepts.
- Thoughts an agent such as Antigravity has between tool calls now show as compact Thought rows
  instead of "Thought" plus "(empty response)" messages. A turn that ends on a thought without
  ever replying says "Finished without a reply".
- Cursor and Antigravity reviewers in workflows can run read-only commands such as `gh pr view`,
  `gh pr diff` and `git log`, and fetch web pages, instead of failing with "Workflow read-only
  profile violation". Anything that would change files is refused and the model keeps working; a
  stage fails only after three refused operations in one turn. Claude read-only stages get the
  same allowance instead of failing on the first refused tool.
- A workflow stage that failed for a read-only violation stays failed even if the provider
  finishes the turn afterwards, and shows the first violation instead of the last. A provider
  that keeps working after the interrupt has its session stopped after 10 seconds.
- Screenshots pasted into the New Workflow requirement field now attach as file chips instead of
  showing "File attachments require the desktop app". F5 keeps a copy for 30 days so the workflow's
  agents can open it.
- An Antigravity turn stopped by the account quota now keeps its usage-limit notice, with the
  reset countdown and the option to continue after the reset. Before, the turn showed a plain
  error banner because its usage limit was cleared as soon as the turn ended.
- Guarded theme and client-settings `localStorage` writes so switching themes or completing settings migration no longer throws when browser storage is restricted or full.
- Bounded long-lived in-memory tracking maps in server runtime ingestion and the Claude adapter to prevent unbounded memory growth during extended uptime.
- Memoized document sanitization and iframe source generation in the document preview viewer so zooming or changing themes no longer re-sanitizes the entire document on every click.
- When Antigravity's saved sign-in expires between sessions, Usage now says so and asks you to
  start an Antigravity turn to renew it. It keeps showing the last-known limits, including after a
  restart, instead of claiming the installed version does not expose account usage.
- Codex read-only workflow stages (reviews, investigations, documents) now run in Codex's
  read-only sandbox with no network for shell commands. They used to run with the thread's access
  mode, so only the prompt kept them from writing. A stage fails to start if Codex reports any
  other sandbox.
- Codex read-only workflow stages get only F5's read-only forge and thread tools. Your own Codex MCP
  servers, the preview browser and Codex plugins are left out of those stages, since Codex uses MCP
  tools without asking and they run outside its sandbox.
- Read-only stages on Cursor and Antigravity allow F5's forge tools only when the call really
  targets them, and Antigravity's own calls to those tools are no longer refused.
- `repository_file_read` reads files whose names contain spaces, `#`, `:` or parentheses, and the
  forge tools look up the thread's repository without running `git status`.
- A pre-release of a certified provider version is no longer treated as certified, and an excluded
  version also excludes its hotfix and build variants.
- Read-only workflow stages on Antigravity and Cursor refuse a command that asks to run outside
  the provider's sandbox, even when the command itself only reads. Before, an Antigravity
  reviewer could retry an allowed command such as `gh api zen` with `BypassSandbox` and reach
  the network from outside the sandbox.
- The workspace picker no longer spills outside its popup when the checkout has a long path. The
  path at the top is shortened in the middle, so the worktree folder name stays visible.
- Messages that were sent just as the connection dropped stay pending and are retried
  automatically up to twice after reconnecting, without adding the message twice.
  If reconnection or synchronization fails, you can restore the draft.
- Invalid provider settings, such as an out-of-range Claude auto-compact window, show an inline error while F5 keeps using the saved configuration. Resetting the provider clears rejected edits.
- Shell hooks that update the terminal title no longer corrupt the environment F5 uses to find provider CLIs.
- F5 desktop on Windows honors a saved `DO_NOT_TRACK` setting even when the launcher started before it was set.
- Workspace filename and content search are unavailable when the project folder is your home
  directory or a filesystem root. Open a subfolder to search it, or browse folders directly.
- The Models section of the new-workflow dialog, the Implement dialog and the port review options
  now show each model and its effort as two matching fields. Model names are left-aligned, the
  columns line up on every row (including removable rows), and the run estimate sits on one line
  under the merge row. In a phone-width dialog, the row label moves above its fields so the model
  name stays readable.
- Read-only workflow stages on Antigravity and Codex work in the macOS desktop app again. Their
  sandboxes can't start inside the app's own sandbox, so every command failed with
  `sandbox_apply: Operation not permitted`. F5 now checks once and, where the sandbox can't start,
  runs these stages without it and approves only commands on its read-only allowlist. The stage
  shows **Read-only stage: policy-enforced**.
- Read-only stages on Cursor and Antigravity no longer refuse scripts that set a variable to a
  literal and use it later, such as `HEAD_SHA=abc123` followed by `git show "$HEAD_SHA"`.
  Variables like `PATH`, `HOME`, `PAGER` or `GIT_DIR` still can't be set.

### Security

- Provider logs no longer store API keys, access tokens, JWTs, `Bearer` and `Basic` credentials,
  passwords in URLs or private keys that appear in agent output; they are written as
  `[REDACTED]`.
- The Upstream page and its remote-mismatch error no longer show a token or password embedded in
  the upstream remote's URL.
- Added defense-in-depth `Content-Security-Policy`, `Referrer-Policy`, and `Permissions-Policy` headers on static HTML responses and enforced Origin checks uniformly across all private `/api/` HTTP routes.
- Capped active in-memory session and per-source authentication failure tracking maps in the server auth layer to guard against memory exhaustion under repeated login or failed-auth traffic.
- Centralized Electron main-process app IPC handler registration (including credential bootstrap `desktop:get-ws-url`) behind a mandatory F5 app main-frame origin and ownership guard so preview webviews, HTML sandboxes, and foreign-origin navigations cannot invoke covered desktop channels.
- Scrubbed `F5_AUTH_TOKEN` alongside `T3CODE_AUTH_TOKEN` from server process environment and child provider/terminal spawn environments, and isolated desktop/dev-runner launchers from inherited `F5_*` server variables.
- On Windows and macOS, the desktop app now encrypts its cookies, including cookies imported into
  the preview browser, with the operating system's key (DPAPI on Windows, the Keychain on macOS).
  Cookies written or replaced after the update are encrypted; older ones keep working and are
  encrypted the next time they change. Reinstalling an older F5 release afterwards loses these
  cookies. Linux is unchanged for now.

## [0.1.11] - 2026-11-23

### Added

- Claude threads warn, once per session, when the Claude login may end within 7 days. Claude's reported end date can be up to 3 days late, so the warning gives the earliest date.
- When Claude refuses to start because one of its config files is not valid JSON, F5 names the file and, when Claude found one, the backup to check before restoring it.
- Full access for Claude stays off while a managed policy source on this machine (a macOS profile, the Windows registry policy or the managed settings file) fails to load, and F5 says which one.
- The composer's usage limits popover shows the same pace marker as the Usage page: each limit bar marks how much of the window has elapsed, and the reset line says whether usage is on pace, ahead of it or under it.
- Add opt-in Codex audio attachments for models reporting audio input support and opt-in animated image generation; preserve generated GIF files.
- Configure Codex gateways, Bedrock and Vertex AI from provider settings, choose a native provider for new conversations, and sign in to gateways with browser or device authorization.
- Display Codex account security setup notices without changing account security.
- Antigravity usage limits can read Gemini and shared Claude/GPT subscription quotas directly from the signed-in CLI account, without a separate usage hub.
- Expanded timeline commands highlight shell syntax and embedded scripts, including Python heredocs and PowerShell commands.
- Use Cmd+F or Ctrl+F in workspace and pull-request diffs to search virtualized lines. Navigating to a match opens its collapsed file.
- The model picker separates current and legacy models using a bundled manifest. An opt-in remote refresh keeps classification current, with an on-disk fallback when offline.
- Signed macOS builds with the required entitlements support Touch ID and system passkeys in preview tabs, with an account picker when a site offers multiple credentials.
- The welcome screen now links to agent setup and lets you discover projects from configured Codex and Claude homes, with optional recent-thread history import. Imports preserve profile isolation, approval settings, and existing conversations.
- Configure OpenAI-compatible or Anthropic text generators in Providers settings to write titles, commit messages, pull request text, and structured text without launching an agent. API keys stay in the server secret store.
- Claude models offer an independent Ultracode toggle that preserves the selected effort level.
- Type @ and part of a model or provider name to name a model for the agent. Model references appear as provider-icon chips in the composer and messages.
- /clear arms a fresh provider session for the next message in the same conversation. Earlier messages stay visible, with a New session divider.
- Conversation-bound scheduled tasks can start each run with fresh context; this option is off by default.
- GitLab merge request reviews can request changes, with server refusals reported instead of claiming success.
- Agents can preview and publish HTML from a local file path in full-access conversations, without copying the page into tool arguments.
- Pi extension status messages appear above the composer, update by key, and clear when the provider session stops.
- Pi models that advertise service tiers offer Standard, Fast, and Ultrafast speeds independently of thinking effort.
- Add pull request comments to chat as context without asking the agent to fix them. Use the adjacent composer, select a linked conversation, or create a conversation in a local project.
- Scheduled tasks can be moved to another conversation in the same project from the task editor.
- New and existing tasks can target an existing conversation. Changing projects clears the destination, and moving a task cancels runs still waiting for its previous conversation.
- Claude's model picker includes models reported by Claude Code gateways, preserving their selectable IDs, context-window variants and supported reasoning efforts. Gateway discovery can finish in the background after a model probe.
- Complete user mentions and issue or pull request references with a keyboard-accessible suggestion list in PR composers. GitLab also supports merge request references beginning with an exclamation mark.
- Pin favorite projects from project rows, the command palette, or Settings → Projects. Pinned projects come first in project pickers. Archive projects to hide them from pickers, and restore them from Settings.
- Open a side chat with its own composer in a right-panel tab using /side, /btw, or Add. Side chats copy the current conversation context while the main thread keeps running, and stay out of the main thread lists.
- When a Claude or Codex turn fails because the account's login expired, the thread now offers **Sign in again**. It runs the provider's sign-in in place. Once the login succeeds, it resends the message with its original settings, but only if the turn hadn't started working yet.
- Choose Standard or a Daybreak Cyber Access program in Codex model traits when the model advertises support.
- Managed Antigravity can update from Google's CLI release channel without waiting for an F5 release. Fresh installations use F5's pinned checksum; later updates trust Google's HTTPS manifest and check downloads against its SHA-512 checksum, rather than an independently signed manifest.
- Enable “Keep usage limits visible” in Conversation settings to keep provider limit windows and thread context usage above the composer.
- Enable “Keep the server awake while agents work” in Threads settings for standalone servers, with a one-minute grace period after runs finish. Linux also inhibits manual suspend while active. Desktop servers keep using their existing Keep Awake controls and safeguards.
- Drop folders from your file manager onto the desktop sidebar to open them as projects and start a thread. Existing projects are reused.
- Press Cmd+Shift+B on macOS or Ctrl+Shift+B on Windows and Linux to toggle the Agents panel
  in the main thread view. The default shortcut is inactive in terminals and dialogs, and
  your custom keybindings take priority.
- On Node-based servers with tracing enabled, traces show significant heap growth on individual
  operations and list likely contributing operations when the server heap spikes.
- An opt-in Appearance setting renders LaTeX equations in chat, with lazy-loaded typesetting and copyable TeX source.
- Claude approvals explain whether an ask rule or a provider safety check prompted for approval in Full access.
- Pull request change totals show a breakdown of code, tests, mocks, generated files, and documentation on hover or keyboard focus.
- Startup failures now show reload and update actions, terminal debugging guidance, and copyable crash details with a link to report the problem.
- Projects discover Git repositories inside their folder. Use the repository picker to review and
  commit changes in each repository, and review turn changes across the whole project.
- Choose which repositories to include in a new thread worktree, including when the project root
  is a plain folder. Files outside repositories in a plain-folder worktree link back to the
  original project folder. You can also add an external repository in Project Settings.
- Review and approve repository-defined worktree layout commands in Project Settings.
- Agents can read pull requests and CI on the thread's forge and make changes in the thread's repository through F5's forge sign-in, including re-running jobs and merging GitHub stacks.
- Settings can unassign an individual default keyboard shortcut while keeping the action's other shortcuts.
- Set usageHistoryRetentionDays in settings.json to keep imported Muse usage history for a custom number of days or indefinitely. The 182-day default preserves both periods in the 90-day comparison.
- Antigravity can sign in with a Gemini API key as well as a Google account. The key is kept in
  F5's secret store, threads start only after a successful Connect, and the Usage page shows
  "Billed per token" for it.
- The Antigravity provider card shows the runtime version and source, model catalog freshness,
  the kind of the last discovery failure, and whether F5's native readers are on. Quota,
  turn-failure details and native child work now run only on Antigravity versions F5 has
  certified.
- Antigravity models show a Thinking control with the levels each Gemini model supports, and the
  composer's context meter now works for Antigravity threads.
- Antigravity supports Auto-accept edits, the composer's Plan toggle, and Auto when the installed
  version offers its own reviewer.
- Cursor threads show subagent task cards, keep the to-do list when Cursor sends partial updates,
  and show images Cursor generates inside the workspace.
- Cursor threads pick up the title Cursor assigns, pass non-image file attachments to Cursor, and
  list the skills Cursor installs in `~/.cursor/skills-cursor`.
- Remote project MCP servers are passed to Cursor, with a warning naming any server F5 left out.
- For a Cursor CLI installed with Cursor's installer, the provider update notice now shows how to
  update it (`agent update`).
- In Plan mode, Antigravity's plan appears as F5's plan card, with Implement and refine, as it does for Claude, Codex and Cursor.
- Antigravity asks its questions in F5's question card instead of in its reply. The card stays open, and Antigravity keeps waiting, until you answer or its turn ends.
- Antigravity's own plan, task and walkthrough files show as "Updated artifact" entries, not as changed files in F5's profile folder.

### Changed

- Update the bundled Claude runtime to Claude Code 2.1.326 (Agent SDK 0.3.326). In Full access, commands that contain your signed-in account email (for example a request header your team's tooling requires) no longer stop for an approval. Claude Code now refuses only calls that send the address as a client's identity, such as a User-Agent, and tells Claude to try again without it.
- Claude MCP servers' environment variables and headers now reach the bundled runtime over its input instead of its command line. Custom Claude executables older than 2.1.326 keep F5's earlier private setup path.
- Claude approval cards offer **Always allow this session** only when accepting it would actually save something. Otherwise only one-time approval is offered.
- Upgrade bundled Codex from 0.166.0 to 0.170.0, including upstream OAuth, reconnect, sandbox inheritance and Windows fixes. Custom executable paths remain supported.
- Update the managed Antigravity runtime to the supported 1.5 CLI, surface quota errors as failed turns, show native child work in the Agents panel, and preserve native file reads and diff edits without creating a workflow skill in the project. Updates remain explicit in Settings.
- The context meter shows used tokens against the model limit, warns at 80% and 90%, and marks Claude's configured auto-compaction point when available. Context remains separate from provider Usage limits.
- Copy a thread link separately from its raw ID, or use the copy-reference shortcut to copy its PR link when available and its thread link otherwise. Pasting a thread link inserts a context chip at the cursor or replaces the selection.
- Images and videos appear above message text, and multiple images share a collage. Files sent on their own appear as file cards, pasted text is labeled “Pasted text”, audio attachments have playback controls, snapshots retain their aspect ratio, and pending file sends show “Sending…”.
- The composer's reasoning chip shows only what differs from the defaults: "High" instead of "High · Ultracode Off", with icons for Fast mode and Ultracode when on.
- The context meter is now just the ring. Hovering it shows the percentage inside the ring and the exact token counts in the popup.
- Projects are pinned and unpinned from their actions menu. The always-visible pin button in the sidebar header is gone; pinned projects show a small pin next to their name.
- Pending approvals appear on their timeline row with the full request and approval actions, keeping the composer free of approval banners.
- When you reference another thread in a message, F5 gives the agent the exact arguments for
  `thread_read`, even when long titles fill the reference context.
- Find in thread highlights matches across nearby messages and plans as you scroll, including
  matches deeper in long messages. The count still includes the whole thread, and the selected
  match stays highlighted while its row is rendered.
- Sidebar titles shimmer as they regenerate.
- Hover or focus the conversation header's Diff button to see how the working tree's changes break down across code, tests, mocks, generated files, and docs.
- Searching for "Gemini" or "Google" in Add provider and the model picker finds Antigravity, and
  the separate Gemini "coming soon" entry is gone.
- Antigravity lists Orchestrator first, uses a light Gemini model for titles and commit messages,
  and reads `skills.json` and plugin skills.
- Each Antigravity instance now reads your `~/.gemini/AGENTS.md` and `GEMINI.md`, as Antigravity
  does outside F5. Files and links of your own in the instance profile are kept.
- Changing Antigravity's sign-in method, key or Google account starts fresh native sessions on the
  next message instead of resuming the previous account's session.
- Switching provider in Home or the workflow Implement dialog now keeps the access mode when the
  new provider offers it, narrows it when it doesn't, and never widens it to Full access. When only
  wider modes remain, you pick one before starting.
- ACP providers (Grok and custom ACP agents included) now apply configuration changes the agent
  reports on its own, such as a model or mode it switched itself.
- Updating Git file counts refreshes the chat header without re-rendering the conversation and composer.
- Switching conversations is smoother in sidebars with many threads.
- Antigravity is now listed in Settings → Providers and turned on by default, like the other
  built-in providers. F5 still installs it only when you click **Install Antigravity**, and nothing
  starts until you sign in. Switch it off there if you don't use it.
- In Antigravity plan mode, commands and read-only tools follow the thread's access mode: Full
  access runs them without asking, and Supervised asks and offers "Allow for this thread". File
  edits and unrecognized tools still always ask in plan mode.
- Expanded command cards present output by what it contains: file reads show their file's syntax
  colors and, when known, its line numbers; `grep -n`/`rg -n` results are grouped by file with
  matches marked; diffs are tinted; JSON is highlighted; and terminal colors show instead of escape
  codes. When the output names a file and line, clicking it opens the file there. Very long output
  stays plain text.

### Performance

- F5's HTTP MCP catalogs advertise smaller input schemas while keeping full validation when tools run, reducing tool context for HTTP MCP clients. Claude's in-process catalogs keep their existing schemas.
- Agent instructions no longer encourage routine exploration and verification subagents, and use less context for HTML tool guidance.
- Pull request queues render the first rows sooner. Hovering or using the keyboard to rest on a
  row warms any available cached detail without contacting the forge.
- Pull request link previews show known titles and status immediately. After a reload, recently
  opened timelines, checks, and diffs can show cached data while they refresh.
- Clearing PR Hub data, removing a forge account, or disconnecting GitHub also clears saved
  pull request reads in the browser.
- Codex can start tool calls while a detailed reasoning summary is still being generated. Reasoning summaries appear one section at a time.
- F5 stays responsive on Windows while looking up executables for providers, terminals, and editors.
- Repeated checks for missing Windows commands are faster. F5 reuses unchanged PATH directory listings across command checks and launches.
- Reconnect faster on unreliable networks and catch up on recent thread changes without reloading the thread list.
- Keep large thread and settings updates moving on slow connections.
- The desktop thread list can reuse a recent snapshot from the same server on startup. Remote connections reload larger sync gaps over compressed HTTP.

### Fixed

- Reloading MCP servers in a running Claude thread no longer disconnects F5's own thread, preview and computer tools.
- When an agent waits for its turn at the computer (because you are using the app or another agent holds it), the wait now shows as a step in the **Used the computer** card, with an hourglass and the result, instead of a separate MCP row that split the card in two.
- OpenCode native slash commands receive only the arguments you typed. Images, plain-text files and PDFs are still attached; other file types are omitted from native commands.
- Agent Bridge's list_scheduled_tasks tool now honors scheduledTaskId within the projects shared with the caller.
- Apply Reviews recognizes the implementation worktree’s automatic branch rename and can retry
  a failed context recovery without sending an already delivered review turn again.
- Apply Reviews keeps recovered context when Claude resumes, reports later session resets, and
  preserves completed workflows when older revision history cannot be verified.
- Apply Reviews can recover context on the implementation thread when the saved reviews do not
  fit. It sends both reviews in full and waits for the revision turn to finish before marking the
  workflow complete.
- A Codex command with large output no longer stops the turn with "notification admission was
  exhausted" when the next command starts. If that error still happens, the turn now finishes
  instead of leaving the conversation stuck on "Waiting for the active turn to finish". Stop works
  on such a conversation too, and on the next app start F5 clears a stuck turn it can still
  identify from its saved session state.
- Preserve other assistant items when moderation replaces one item, and sanitize native child-task inspection output.
- Keep ordinary audio files usable when optional native-audio configuration reads fail.
- Restart gateway sign-in polling for each attempt and bound how long configuration reads wait for dispatch.
- Require a fresh one-time decision for Codex human-required commands, regardless of session allowances.
- Keep MCP app resource reads tied to their originating Codex call and connector account.
- Replace provisional Codex answer text when the final native presentation hides or blocks the response, including history and child transcript reads.
- Apply the selected native Codex provider through managed process options for conversations and auxiliary title, branch, commit and PR generation.
- Resolve startup service tiers after Codex opens the conversation's native provider, preventing recovery from applying another provider's tier.
- Preserve ordinary audio-file attachments when native audio is disabled or unsupported, and validate the exact model sent with a recording.
- Replace moderated text and reasoning in current and earlier turns, including one-off summaries and persisted conversation views.
- Keep gateway sign-in polling and cancellation available while inspecting other providers, and isolate successive OAuth attempts.
- Keep native provider settings recoverable after an unavailable provider selection and avoid duplicate gateway creation after refresh errors.
- Reject invalid MCP account targets and refresh provider catalogs after configuration changes.
- Preview tabs restored before entitlement checks finish gain passkey support when the check completes. Set F5_DISABLE_PREVIEW_PASSKEYS=1 before starting the desktop to disable F5's passkey integration.
- Stopped desktop profiles no longer cause repeated synchronous IPC on every URL lookup.
- History imports advance one thread at a time with visible progress, and active multi-project imports keep their scan alive. Projects with large Codex instruction records can be discovered, and import toasts use the correct singular form.
- Model lists ignore caches from a different manifest source. Expanding another command can retry a failed highlighting download, and large commands use bounded coloring without loading the full renderer.
- Turning off online model classification restores the bundled lists. Model refreshes finish pending cache writes before the backend shuts down.
- Newly reported models keep their normal picker placement instead of being labelled legacy merely because they are absent from the bundled catalog. Optional manifest updates come from F5 and update connected pickers immediately.
- Diff cards show both paths for renamed files and fold when their header is clicked. App navigation shortcuts remain available while diff search has focus.
- Importing CLI history limits message and thread text, reports shortened history, and consistently resumes Claude sessions by their transcript filename. Leaving a failed import restores the previous onboarding state.
- Expanded commands retain lightweight coloring while full highlighting loads or fails, including a bounded preview for large commands. Failed embedded-script downloads can be retried.
- Desktop startup no longer waits for macOS passkey entitlement inspection; passkeys become available once the signed entitlement check finishes.
- Find in workspace diffs now receives Cmd+F/Ctrl+F beside the chat, and typing in diff search keeps conflicting text-editing shortcuts from interrupting it. Unchanged files retain their render versions, and collapsed headers keep their theme without highlighting file contents.
- Antigravity usage preserves partial quotas when an endpoint stalls and returns within the usage refresh deadline.
- Project history imports avoid checkpoint snapshots and clean up unclaimed bindings after a rejected import. Syntax highlighting can retry a failed grammar download.
- Timeline command rows show the script inside simple Windows cmd launchers, matching existing PowerShell launcher handling.
- Fresh sessions recover safely after failed starts; model mentions keep files first, Pi speeds survive optionless turns, and extension banners clear when switching providers.
- Canceling API text generation cancels its HTTP request. Stored API keys no longer follow a changed endpoint origin or API type, and plaintext endpoints are limited to loopback hosts.
- Fresh sessions exclude earlier plans, task lists and recovery summaries, including immediately after a clear. Pi extension status updates are coalesced.
- Review guides can select API text generators. Clearing a replacement key field keeps the stored key, generator ids cannot shadow provider ids, and unreadable HTML paths show actionable errors.
- Terminal output containing URLs such as `redis://`, `postgres://`, and `s3://` no longer shows broken editor links.
- Open in Editor and Reveal in File Manager can reach the Linux desktop session when the server starts at boot before you log in.
- Reveal in File Explorer selects files from links with forward-slash paths, including paths with spaces.
- Stopping the server during Windows startup also stops the background PowerShell PATH probe.
- Windows startup can read PATH through PowerShell 7 if Windows PowerShell fails to run the probe.
- Typing into a search box or combobox with computer control no longer pauses the thread with
  **Needs recovery** when the typed text moves focus to a list option. If focus really moves
  partway through the text, typing stops and the agent is told how much was sent and why.
- Claude's removal safety checks in Full access mode return their warning and safe-rewrite guidance to the agent instead of asking you to override the check. Explicit approval rules still ask for your decision.
- Project picker options keep their project names for assistive technology and keyboard selection when pin buttons are shown.
- Planning revisions use the context window reported by the authoring provider. If a revision runs out of room, its branch shows how to recover while the other branch can continue. Retrying reuses the saved reviews.
- The Claude Ultracode switch now stays on when turned on, in the composer and in workflow model slots.
- The Profiles card no longer lists every removed thread worktree as an unavailable project folder. It checks only live project folders and groups several into one collapsible warning.
- ACP providers show session notices separately from the assistant's reply, including warnings about skipped skills.
- Server keep-awake preserves Linux screen locking and prevents Windows host sleep when F5 runs in WSL.
- Approval requests respect the typing guard, retain timeline row reuse, and avoid empty composer-header spacing.
- Desktop activation and sidebar folder-drop handling load on demand, keeping the initial bundle within its budget and thread file-drop targets visible.
- Antigravity update output reports the installed version and avoids oversized free-space estimates.
- Cyber Access defaults to Standard and drops choices unavailable on the selected model.
- Pending approvals retain provider explanations and paths, with a composer shortcut to reach off-screen requests.
- Managed Antigravity recovers from missing active releases and serializes release selection across server processes.
- Startup ACP notices retain their titles and details, and persistent usage shows short-term limits and stale-data warnings.
- HTTP MCP schemas preserve each action variant's required fields and keep nullable-only inputs valid.
- Atomic saves of settings and other app state preserve existing file permissions on macOS and Linux and give new files owner-only access. Settings and keybinding saves also sync to disk to reduce data loss after a crash.
- Math rendering preserves shell variables, prices, escaped dollars and table columns; copying or quoting equations keeps their TeX source.
- PR change breakdowns reuse cached statistics without downloading GitHub patch bodies, and queue hovers wait for intent before loading.
- Startup recovery avoids a theme flash, preserves useful stack locations in copied reports, and only offers verified terminal commands.
- Keep multiline equations and rich clipboard formatting intact, and leave shell variables beside links as prose.
- Redact URL credentials from startup reports while retaining useful stack locations.
- Verify the revision behind PR change breakdowns, avoid changing saved PRs when reading statistics, and preserve queue keyboard navigation.
- Link shell-created PRs only from unambiguous successful create commands and known forge hosts; explain organization-managed Claude approval rules.
- An opt-in Git setting links merge requests created with GitLab's shell CLI to the thread. Shell PR detection now ignores quoted examples, comments, and ambiguous output.
- Dragging with a mouse or pen to select conversation text now works across the turn rails and minimap without opening a turn preview or unexpectedly extending the selection.
- Claude’s context meter shows the auto-compaction point from Claude’s own settings when F5 has no override.
  An explicit F5 override also takes precedence over Claude’s environment variable for the compaction window.
- Claude’s context meter uses the context window reported by Claude for models outside F5’s catalog.
- Commands that are still running when Codex closes their thread show as interrupted.
- Images embedded in Codex tool output appear inline in the conversation.
- Side chats started with /side or /btw carry along the first message's attachments and context. If the send fails, the original draft stays in the main chat.
- Cancelling a command while F5 is looking up its executable prevents the process from starting.
- Cursor and VS Code links to local files open the named editor at the specified line and column when clicked in chat.
- F5 checks and updates supported mise-managed providers through mise. Version-pinned installs and OpenCode 1.x stay manual.
- Model and reasoning-option picks on the current provider instance are saved for the next turn. Switching provider instances takes effect when you send. Answers to pending questions stay with the running session.
- Pi keeps other extensions’ system prompt changes when adding F5’s orchestration guidance.
- Antigravity shows as signed in after a Google sign-in with Antigravity 1.5.x, which keeps the
  sign-in in a file F5 didn't read. Usage limits read it too, and sign-out removes it.
- Turn checkpoints work in a separate profile that has no Git author set. They failed with
  "Checkpoint capture failed … Author identity unknown", which removed per-turn diffs and undo.
  Your own commits still need the profile's Git author in Settings → Integrations.
- Antigravity updates no longer turn off subscription quota, turn-failure details and sub-agent
  work. F5 now reads them on any Antigravity from 1.5.13 up instead of only on versions it listed,
  and it reads the new way 1.5.15 records sub-agent launches.
- The chat header's View PR, Git action and project action buttons keep their dropdown chevron
  inside the button group instead of pushing it past the group's edge.
- Prevent unrelated terminal state and slow macOS test setup from blocking beta release checks.
- ACP permission requests that include the tool's input, such as Antigravity asking before a
  command in plan mode, now show an approval card instead of failing and ending the turn with no
  output.
- Antigravity approval cards show the command being approved instead of `run_command`.
- Switching threads after opening a search result, a "Replying to" card or an Agents panel item no
  longer shows "That message is no longer available." on every thread you open next.
- "Quote reply" now appears as soon as you finish selecting assistant text, including keyboard
  and touch selections, instead of only after copying it. Escape closes it, Back from the comment
  keeps the selection, and adding a quote keeps the composer's cursor.
- Sent messages no longer show extra blank lines between a quoted response card and the text
  around it.
- New threads in a project folder that is not a git repository but holds repositories start in the
  project folder again instead of failing on the first message. A worktree of selected repositories
  is now a choice in a searchable workspace picker under the composer.
- Keep focus in project search and preserve the composer's caret or selection when a thread finishes loading.
- Preserve selected draft text when the app window regains focus so pasting replaces the selection.
- Keep automatic composer focus after thread navigation without letting closing popups or hovered tooltips block typing.
- The experimental Linux VM profiles (`F5_EXPERIMENTAL_LINUX_VM=1`) can start from the released
  Apple silicon app: it now ships Lima, signed for virtualization, and downloads the matching
  Linux backend from its own release the first time a VM needs it. A slow download no longer
  trips the startup timeout while it keeps making progress.
- macOS and Windows packages no longer carry a second, unused copy of the native helper inside
  the app archive.
- Cursor questions now send the answers you picked instead of an empty reply, and skipping or
  stopping tells Cursor the question was skipped or cancelled.
- Cursor questions that arrive as permission prompts are no longer approved automatically in
  full-access threads.
- Cursor no longer leaves an abandoned session in `~/.cursor` for every commit message, PR text or
  title F5 generates with it. That text is now generated in a private scratch folder, so project
  rules do not apply to it.
- Cursor shell commands that exit with an error now show as failed, and tools still running when a
  turn is stopped or fails show as interrupted. Backgrounded commands stay open across turns until
  Cursor reports them, and their updates stay with the turn that started them.
- Cursor threads refuse runtime modes Cursor cannot enforce instead of silently running with
  different permissions.
- Steer now stays available for queued turns after the agent switches branch or worktree mid-turn,
  instead of being disabled until the turn ends.
- `grep -n`/`rg -n` results in expanded command cards are grouped by file and highlighted when
  the output goes through `head`, `tail` or another `grep`/`rg` filter (such as `| grep -v test`),
  instead of showing as plain text.
- A message sent to Antigravity, Grok or Cursor no longer shows as queued for the whole turn. It
  leaves the queue as soon as the agent starts working on it.
- Command cards for Antigravity, Grok and Cursor now show the command's output instead of
  "(no output)". A command Antigravity was not allowed to run shows the reason.
- Antigravity and Grok commands that exit with a non-zero code now show as failed, with the exit
  code, instead of completed.
- Antigravity command cards are headed with Antigravity's own summary of the command, such as
  "Inspect repository top-level layout", instead of a generic label.
- Antigravity's 5-hour and weekly limits on the Usage page now show the pace marker, and the
  composer's limits gauge shows Antigravity's most-used weekly limit.
- Commands on command cards keep the same syntax colors when a card is expanded or collapsed.

### Security

- Grok commit, PR, branch and title generation no longer inherits always-approve settings. Grok, custom ACP and Antigravity metadata generation deny tool approval requests.
- Other websites can no longer embed the F5 web app in a frame to disguise approval or thread actions.
- Preview, computer, thread, and integration MCP endpoints now refuse browser requests with 403 before checking credentials, including preflight requests.
- Desktop connection tokens rotate every 12 hours. Reconnecting windows obtain a fresh token, including after a backend restart or a long sleep.
- A profile recorded as running in a Linux VM now refuses to start on the host, from desktop,
  server and CLI profile selection alike, and shows why. The profile registry is written in its
  newer format only while such a profile exists, so installations without one stay readable by
  older F5 builds.
- The desktop preview requires a trusted click to attach an element annotation. Page scripts and
  F5 browser automation cannot submit a pick. Start picking after the preview page finishes loading.
  Leaving the tab or leaving a pick idle for a minute cancels it.
- The desktop preview asks before a local app can access your location and remembers your choice for that origin until F5 restarts.
  The choice follows the origin, including its port. Permission queries report denied until an app
  requests location directly and you allow it.
- Antigravity no longer inherits Google application-default credentials or Google Cloud project
  settings from the server environment, and Full access approves each action once instead of
  switching the agent to its own unattended mode.

## [0.1.10] - 2026-11-17

### Added

- The Claude card on the Usage page lists your plan's limit resets (such as **Full reset** and **Fable reset**) with their expiry, and each has a button that uses it after you confirm, as on claude.ai. A reset that can't be used yet says why, such as "Usable once you hit a limit". When your tightest Claude limit is used up, the reset Claude suggests next appears beside it, and threads paused on that limit resume once it is cleared. F5 reads the sign-in Claude Code already stores, so macOS may ask once to let F5 read it from the Keychain.
- Markdown continuation in the composer, supported High effort defaults, and compact per-turn token footers.
- Linux builds include a Debian/Ubuntu package alongside the AppImage. Installed Debian packages can download and install updates from F5.
- Desktop users can enable **Keep running threads synced** in Conversation settings to keep all active threads ready to open, including threads outside the recent-thread cache.
- VS Code and file-manager actions for local paths and project breadcrumbs.
- Opt into **Proactive panels** in Conversation settings to open linked pull requests and completed-turn diffs. Manual panel choices take priority and dismissed turn diffs stay dismissed.
- Choose a project image in Project settings by entering its path inside the project. Emoji, colored symbols and automatic monograms remain available.
- Separate prompt and response navigation rails, optional follow controls, and visible earlier-history loading.
- Conversation usage limits above the sidebar profile, with pinning and account-scoped refresh.
- Start, queue messages to, list and read threads from a terminal with `f5 thread` (or `t3 thread`). Use `--wait` to print the reply and distinguish failed runs from threads or paused queues waiting for you. Local commands use your project defaults, fall back to a ready provider when needed, and can access all projects without enabling the external Agent Bridge. Lists load only the newest 100 threads; transcript reads fetch bounded pages while preserving full text.
- Workflow archive, restore and explicit deletion actions, with shared-thread protection and atomic child deletion.
- A pull request's **Checks** tab lists the checks of the latest commit by workflow, with how long each ran. A failed GitHub Actions job shows its log below it, cut down to the lines around the first error, with **Copy** and **Open full log**. **Re-run failed jobs** starts the failed and cancelled jobs again after you confirm, from the tab, the status checklist or the queue's side panel; it needs write access to the repository. **Fix CI with F5** now gives the agent up to three failing checks with the end of their logs. Logs and re-runs are for GitHub Actions; other checks and forges are listed with a link to their own page.
- Pull requests shows what changed since you last opened each one. A changed row is bold and names its first two changes, such as "2 new comments · Checks failed"; the bell in the title bar counts the changed pull requests and lists the 20 most recent, with **Mark these seen** for the ones listed. Opening a pull request marks it seen. Changes are tracked for GitHub accounts, and pull requests found before this version start as seen.
- Select several pull requests in the queue with their checkboxes, the X key, Shift-click or a section's checkbox, then **Snooze**, **Ignore** or **Mark seen** them together. **Merge ready** merges the selected pull requests that are ready, up to 10 at a time on GitHub: it lists each with its commit and merge method, merges after one confirmation, and reports each result.
- Save a search and its filters as a tab above the queue with **Save view**, up to 12. Each tab shows how many of its pull requests need you, and can be renamed or deleted from the **⋯** at the end of the tabs.
- Reply to an assistant response from its hover actions. A removable “Replying to” bar survives draft reloads and stashing, and sends the response's IDs, opening text, and associated subagents as context.
- Watched GitHub PRs can refresh from host events instead of waiting for the two-minute sweep. Enable the preview with F5_GITHUB_PR_EVENTS=1; polling remains the fallback, and subscriptions are cleaned up when watches stop.
- Muse Code now shows its session and weekly limits with the reported subscription tier. Explicitly configured CLIProxyAPI hubs can read the selected xAI or Antigravity account, and Antigravity history uses a stable Google account fingerprint when userinfo is available.
- OpenCode native todo updates now appear in the task checklist, including progress, cancellations, clears, and updates recovered from the native todo inventory.
- Choose status only, status and messages, or every step for screen reader announcements in Conversation settings. The default remains status only, and the choice is saved on this device.
- Windows installations can run F5 as a per-user Task Scheduler service, with background logs, graceful shutdown, restart, and the launcher's existing update handoff. The service runs while its user is signed in.
- The custom theme editor's color swatches open a color picker, so Background, Text, Primary and Accent can be chosen visually with a saturation and brightness area and a hue bar, by pointer or arrow keys. Typing an exact color still works.

### Changed

- The box at the top of Home starts the thread itself. Pick the project, model, effort, **Agent** or **Plan**, access and **Local** or **New worktree**, then press `Enter`: the thread starts in the background and Home stays open, and `mod+Enter` also opens it. The box follows the **Send shortcut** setting: if it asks for `mod+Enter`, `Enter` adds a line and `mod+Enter` sends and stays. A send that fails keeps your text, and sending the same text again with the same project and settings after a lost connection starts one thread, not two. The confirmation's **Open** button waits for the new thread to arrive before it opens it. Text that begins with a `/` command or a skill, and anything that needs attachments or mentions, goes to the full composer, which the expand button opens with your text and settings.
- Home is now a triage queue. Threads are grouped into **Needs a decision**, **Ready for review** (failed turns and finished work you have not opened), **Running** (with one row per active workflow) and **Pinned**, and the pane beside the queue shows the selected thread's request, error or last reply without opening it. From that pane you can approve or decline a request, answer a question, implement or revise a plan, resume a paused queue, reply to finished or failed work and queue a message behind a running turn; messages use the thread's own model and modes. `J`/`K` move, `O` opens, `E` settles, `H` snoozes, `P` pins and `R` starts a reply; `Enter` approves once or implements the plan (and opens other threads), `D` declines; `mod+shift+H` opens Home from anywhere. A line above the queue counts pull requests and upstream topics waiting on you and shows the next scheduled run, a usage limit above 50% and low disk space. The greeting, the resume banner, the Recent list and the `mod+1`–`9` project shortcut are gone from Home; recent threads are in the sidebar's Recent view.
- Updated F5 icons, sidebar/header controls, model ordering, Find closing and composer readiness.
- PR Hub's **Needs you**, the sidebar badge and pull request notifications now cover only reviews requested from you personally, your own pull requests that need a fix, and your pull requests that are ready to merge. A review requested from one of your teams reads "Review requested from your team" and no longer counts; add a team under **Settings → Git → Teams whose review requests are mine** to count its requests as yours. Pull requests with no activity for 30 days are stale: they leave **Needs you** and sort last (**Move PRs to Stale after**, 0 turns it off). Lists show the most recently updated pull request first instead of the longest-waiting one, **Ignore** has an **Undo** button, and search accepts `repo:owner/name`.
- Usage limits use a shared snapshot cache and serialized account refreshes.
- Pull requests is one queue instead of the Inbox and Focus views. It has a section per kind of work (**Review requested**, **Your action**, **Ready to merge**, **Waiting on others**, **Drafts**, **Team queue**, **Other**, **Stale**; the last four start collapsed and load when opened). Each row shows the review and check state, size, last update, linked F5 threads with their live status, and one button for the next step: **Review**, **Fix CI**, **Resolve conflicts**, **Update branch**, **Address feedback**, **Merge** or **Mark ready**. Selecting a row opens a side panel with its status and description, and Enter opens the whole pull request. Search suggests qualifiers and opens a pasted pull request link, a **Filter** menu with removable chips replaces the rows of filters, and the open pull request, search and filters are part of the address, so Back, Forward and links restore them. Sync details moved behind a status pill in the title bar, forge accounts moved to **Settings → Accounts**, and the page has single-key shortcuts (J/K, Space, Enter, Esc, /, A, M, S, E, O, R), listed in the keyboard shortcuts dialog.
- The pull request page is redesigned. Its action bar has one button for the next step, a **Merge** button with **Merge now**, **Merge when ready** (the forge merges once reviews and checks pass) and the merge method, a **Review** button with **Approve**, **Comment** and **Request changes** when a review is requested from you, and **Snooze**; the rest, including **Convert to draft** and **Copy link**, number and branch name, is in the **⋯** menu. The tabs are **Overview**, **Conversation**, **Threads**, **Files**, **Checks** and **Guide**. **Overview** opens with the review, checks, branch and thread status, each with its step (**Request reviewers**, **View checks**, **Update branch** or **Resolve with F5**, **View threads**), and sync diagnostics are folded under **Sync details**. Reviewers are picked from a list instead of typed as comma-separated names, on the page and when re-requesting a review. The pull request panel beside a thread uses the same layout.
- Conversations follow new messages again while scrolled to the bottom, and stop when you scroll
  up. The Follow switch next to Jump to latest and the "Follow new messages by default" setting
  are gone.
- Switching the project folder's branch from F5 is no longer refused because other local
  threads, including archived ones, reference the folder. Only live use blocks it: a running,
  pending or queued turn, worktree setup, an agent session that is starting or running, an open
  terminal or another profile. A new turn waits for a switch that is already under way. When the
  switch is blocked, the error names the conversation and what it is doing instead of a generic
  message, for started conversations too.
- One workspace picker under the composer replaces the Local menu, the worktree chip, the branch
  selector and the "Choose workspace" dialogs. Picking a branch under **New worktree from** opens
  no dialog and creates nothing until you send. Rows for the project folder and existing
  worktrees show how many conversations already work there, instead of asking you to confirm
  sharing. **Switch branch here…** names the conversations that block the switch before you try
  it.
- A thread whose worktree is missing now shows **Recreate worktree** in its header, with
  **Recreate from `<default branch>`** and **Continue in Local** in its menu, instead of a disabled
  "Worktree missing" button. Archived threads show **Worktree removed**.
- "Continue in project checkout" is now **Continue in Local**, matching the workspace picker.
- **Use for this conversation** and **New conversation here** on the Worktrees page no longer ask
  you to confirm sharing; the row already lists the conversations that use the checkout.
- New assistant quotes in sent messages appear as inset, two-line cards with the selected passage highlighted and the comment below. Clicking a card opens and focuses its source response; cards keep their source identity when copied and stay out of Find results.
- The floating Jump to latest control sits centered beside the Working indicator within the
  conversation width, appears only once a conversation has messages, and shows its new-content dot
  to the right of the button.
- Weekly usage limits moved from the sidebar footer panel to a speedometer before the composer's
  model picker. Its needle follows the selected provider's weekly consumption, its label announces
  the percentage, and clicking it opens the limit details. The Usage shortcut stays in the sidebar
  navigation.

### Performance

- The app no longer freezes for seconds when the database checkpoints while the disk is busy. Terminals and the interface keep responding; only work that needs the database waits for the checkpoint.
- Merge message cleanup stays responsive with long malformed agent credits, Markdown links, or large runs of blank lines.
- Project favicon discovery scans only the first 128 KiB of each metadata file, keeping lookups bounded while still finding icons declared near the start of large files.

### Fixed

- Agent Bridge tool calls whose text contains Unicode line or paragraph separators no longer fail with a parse error.
- Background thread sync batches updates and backs off failed loads. Its desktop-only switch is disabled when using F5 in a browser.
- Codex turns now record prompt-cache usage across all model requests, restoring cache history and cache-miss indicators while keeping context occupancy separate. Previously unreported historical usage remains unavailable.
- Forgejo PR watches pass once required checks finish without failure, even if optional checks fail. Skipped jobs and warnings no longer keep watches pending. PR Hub refreshes Forgejo check status during polling and handles server-capped status pages and same-second check updates.
- PR Hub no longer shows "results may be incomplete" while GitHub's request budget only delays part of a refresh. Waiting searches and detail reads continue on the next poll and are listed under the sync details line; your own pull requests and personal review requests are read first. The **Discover PRs from GitHub notifications** setting is now saved, and saving one PR Hub setting no longer clears text you were typing in another.
- Proactive panels preserve manual choices across thread visits, keep dismissed PR panels closed, and open turn diffs without stale file previews or extra browser history entries. Rejected background message loads release their event-buffer retainers so stopped threads can leave the cache.
- Project image choices wait for **Save image** before changing the saved icon. Linux downloads offer AppImage alongside Debian packages.
- Pull requests is back in the sidebar's primary navigation with its "needs you" badge, alongside Usage. Usage limits sit above the profile footer and link to the full Usage page. The Pull requests page shows Settings in the footer; Settings and Usage retain their Back action.
- Workflow deletion retries failed provider shutdowns and offers one cleanup prompt for orphaned worktrees. Reconnects clean retained deleted-thread state without replaying every historical deletion.
- Workflow file-tree drops retain their mentions when editor focus arrives before a queued React render.
- Large worktree submodule clones can run past five minutes while reporting progress. Updates with no output for five minutes stop with a warning instead of leaving worktree preparation stuck.
- Opening a pull request from a notification no longer changes the Pull requests filter, and typing in its search no longer clears the list while results load. The forge account chosen for Pull requests now applies from startup, where the sidebar badge and notifications used the profile's GitHub account until the page was first opened. Pull request panels in threads no longer reload on every PR Hub update.
- A pull request's checks show an icon for their own result. Failed, running and skipped checks used the same tick as passed ones, in a different colour.
- Some of PR Hub's GitHub requests were refused before they were sent, because their paging options were written into the address: reviewer suggestions, the comment and changed-file reads behind review actions and review guides, and **Approve workflow runs**. They are sent now.
- Error messages from a failed request no longer include a server stack trace. A terminal that could not be written to, for example, printed the error followed by a list of internal file paths; it now prints the error alone. The trace is kept in the server log.
- Verbose Codex diagnostics, including large patch failure messages, no longer interrupt turns or block conversations with an incomplete-history error. Excess diagnostic text is summarized without consuming capacity reserved for session events.
- Codex diagnostic excerpts are capped in both the timeline and native event log; omitted lines are counted, and the existing bounded stderr tail remains available for process-exit errors.
- Pull requests on repositories with no review rule now show as "Ready to merge" and can be merged
  from F5 once checks pass and the branch is clean. Before, they stayed in "Waiting on reviewers"
  and Merge failed. Merge now is only offered for pull requests that are ready.
- Claude Fable resets are identified separately from weekly resets, with a confirmation that explains which allowance the selected grant refills.
- Claude Fable reset buttons and confirmation titles now consistently say "Fable reset", even when the account API supplies a weekly or full-reset label.
- Reply and quote context preserves indentation, turn and subagent metadata, clipboard content, and the submitted reply target. Screen reader announcements no longer repeat an older step after failure and can announce identical messages again.
- Windows service shutdown handles starting tasks and update trials safely, with one command lock per installation. PR subscription cleanup includes scheduler wait time, and one unavailable account no longer blocks the rest.
- Muse account history distinguishes API keys. Antigravity waits for a verified account identity before accepting new quota data, preserving existing history through userinfo outages.
- Windows service commands recover from interrupted commands and failed registrations, and can stop a server that never finishes starting. PR event watches retain changes received during a read and subscriptions during backoff, and wait for cleanup at shutdown.
- Usage history keeps the last known Antigravity account identity during temporary userinfo failures. Incomplete Grok hub configuration reports an authentication error. Quote comments remain editable without shifting composer cursor offsets.
- The workspace picker stays usable when worktree inventory is unavailable or incomplete.
- Refused PR reviews now show GitHub's detailed reason. Drafts stay preserved, and submissions that require recovery keep guidance to check their saved state before retrying.
- Mermaid diagrams no longer render as blank space; their size comes from the diagram itself and
  fits narrow conversation panels.
- Agents can publish screenshots from the thread's workspace or temporary directory, including
  macOS `/tmp` paths, as durable conversation attachments with the `image_publish` tool.
- Chat images distinguish loading, paths outside the available directories, unsupported sources
  and failed loads.
- The Worked for divider appears only after a turn finishes, including in threads started without
  a user message.
- Following stays pinned to the latest content while tool output and diffs grow inside existing
  rows.
- The message composer aligns with the conversation's content width and side margins.
- Long agent questions and answer options scroll on their own, keeping the answer editor and
  submit controls visible.
- The Castlevania-inspired Working animation stays inside the Working indicator at its compact
  font size.

### Security

- F5 development and server runtime requirements now use Node 26.13.1 with its HTTP/2 and HTTPS security fixes.
- Sign-in links and browser fallback link opening reject addresses outside HTTP and HTTPS.
- Workspace asset URLs are validated before use so a server response cannot redirect file previews to another origin.
- Terminal history migration and deletion now ignore legacy filenames starting with `terminal_` (in any letter case), preventing those names from reading or deleting another thread's scrollback.

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
