# Upstream porting policy

This file is read verbatim by F5's upstream triage and port prompts (16 KiB limit).
Edit it in a normal pull request. When you answer an open triage question, record the answer here.

## Port when

- The change is a user-visible capability or UX improvement in a surface f5 has: threads, timeline and composer; panels; PR hub and forges; providers (Codex, Claude, Cursor, OpenCode, Grok, Antigravity, Muse, Pi); terminal; git, worktrees and checkpoints; preview browser; usage; settings; desktop.
- It fixes a bug whose symptom can occur in f5's equivalent subsystem. Judge by behavior, not by path.
- It is a measurable performance, reliability or observability improvement.

## Skip

Use the reason keys in `rules.json`.

- `relay-cloud` covers T3 Connect, relay, tunnels, Clerk, outside-agent OAuth, pairing grants and webhooks.
- `maintenance` covers chore, test, ci, docs and style changes, React Compiler adoption, and refactors with no behavior change.
- `upstream-only:<slug>` covers upstream subsystems f5 does not have (listed in `rules.json`).
- f5 has its own scheduler (`apps/server/src/scheduledTasks`). Judge upstream scheduled-task changes by behavior against it. Webhook triggers are `relay-cloud`; interval schedules are `upstream-only:scheduled-task-intervals`. `upstream-only:scheduled-tasks` is retired; do not use it.

## Declined (`declined-by-policy`)

- Working sidebar section (f5 keeps `SidebarAttentionSection`)
- Secret-request card
- macOS default-browser registration
- `t3/` branch prefix (f5 keeps `t3code/`)
- Tool calls without cards, and tool-row redesigns
- Morph icons
- Compact-before-send, and automatic compaction before resume
- Mobile-app nag
- Anonymous-usage note
- Automatic file-link repair
- Trailing toast icons

## Porting defaults

- Final upstream behavior wins; never restore reverted behavior.
- New automatic behavior ships off.
- Keep f5 defaults for `autoResumeUsageLimitedThreads`, `resumeActiveTurnsAfterRestart`, `autoPullDefaultBranch` and `storageCleanup.enabled`.
- Keep f5's Agents panel; port only fixes that improve it.
- Reimplement inside f5's layers. Upstream `orchestration-v2`, `packages/provider-*`, `client-runtime` and `source-control-*` do not exist here.

## Watch

Valuable changes that depend on an unfinished upstream series. Revisit after 30 days.

## Open questions

When a choice depends on an f5 product preference this policy does not cover, ask rather than guess. Once a question is answered, add the answer to this file.
