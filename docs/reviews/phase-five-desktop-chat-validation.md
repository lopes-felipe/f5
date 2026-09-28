# Phase 5 desktop and chat features

This PR implements the approved Phase 5 scope against the pinned upstream target
`f5ef0ddb90a8c36584e181b1913e7b8a5df30ffc`. It does not advance ledger coverage.

## Behavior and defaults

- Desktop quit defaults to a 1,200 ms hold confirmed by key repeat, with a 600 ms
  release grace period and a 500 ms double-press alternative. Settings also offer
  double press and immediate quit. One handler covers app windows, preview guests,
  OAuth windows and DevTools. App windows show the overlay; other windows use a
  native notification when supported. The application menu still quits immediately.
  Windows disappear before cleanup, which is bounded at six seconds. Existing
  update-state reducers retain release notes through download progress.
- Thread notifications offer off, system, sound and system-and-sound. Existing
  `enableThreadStatusNotifications` choices migrate to off/system, including the
  previous system-enabled default. WebAudio sounds, in-app toasts and attention
  badges are opt-in. Sounds require a prior user gesture and play for background
  transitions. Snoozed and archived threads never notify or contribute to badges.
  Multiple desktop windows displaying one profile do not double its badge count.
  Web badges fall back to a title prefix when the browser lacks the Badge API.
- Selecting assistant text offers Quote reply, an optional comment and Add quote.
  Cmd/Ctrl+Enter in the comment sends through the normal composer send path; IME
  composition does not send. Back/Escape retain the comment, Cancel inserts nothing,
  and pressing another action dismisses the selection toolbar. Quotes are capped at
  4,000 characters and serialized as Markdown blockquotes followed by the comment.
  Lexical retains local message metadata while editing; persisted drafts and sent
  messages contain portable Markdown, without server-side citation references.
- Custom models retain string compatibility and also accept `{slug, name?,
capabilities?}`. Settings can rename custom models without changing their IDs or
  capabilities. Existing built-in catalogs, version gates and aliases remain in
  force; custom entries cannot rename or resurrect filtered built-in models.
- Chat Markdown links `#N` and `owner/repo#N` using the current PR's repository or
  the workspace's forge identity. Code and existing links are unchanged. URL rules
  cover GitHub/Enterprise, GitLab, Bitbucket, Forgejo/Gitea and Azure work items.
  Qualified Azure references remain plain text because a repository name cannot
  identify a work-item project. This adds no forge account or write capability.

Protocol **8** protects the custom-model union change. Existing open tabs use the
exact-version reload gate. Bootstrap advertises `custom-model-metadata`,
`assistant-quotes` and `repository-issue-links`; desktop functions are exposed through
optional bridge methods. Web-local preferences remain in `appSettings.ts`.

## Validation

Coverage includes quit timing, repeat cadence, modifier release, delayed mode reads,
popup hints, renderer IPC ownership, per-profile badge aggregation, notification
migration and snooze suppression, quote serialization and selection behavior,
custom-model metadata/aliases, and forge-aware rendered Markdown links.

The full browser suite exercises quote insertion and Cmd+Enter through ChatView,
model renaming, and notification/toast/badge behavior. The isolated built Electron
smoke checks bundled renderer/server startup, draft persistence across reload, the
native badge, a single quit tap that leaves the app open, and double-press quitting
from a sandboxed popup. Native input is injected through Electron's
`sendInputEvent`; CDP keyboard dispatch does not reliably reach `before-input-event`
on this macOS host. The smoke uses temporary app data and no personal accounts.

The local Electron dependency initially lacked its executable. Restoring the already
installed matching 40.6.0 distribution repaired that environment issue. The smoke
also exposed a test cleanup call into Playwright after the app had exited; the test
now retains the child-process handle before shutdown.

Passed checks: `bun fmt`, `bun lint` (10 existing warnings, no errors), `bun typecheck`, `bun run test:full` (including all 133 exhaustive real-Git tests),
`F5_REQUIRE_UPSTREAM=1 bun run upstream-ports:check`, the web browser suite (489 tests), the final toast/quote browser checks (3 tests), and
`bun run test:desktop-smoke`. Native smoke coverage is macOS arm64; Linux and Windows
runtime behavior is covered by unit cases, not a native run on this host.
