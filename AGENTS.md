# AGENTS.md

## Task Completion Requirements

- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
- Run `bun run test:full` at least once before considering a task completed. It includes the fast workspace suite and the exhaustive real-Git matrix.
- NEVER run `bun test`. Always use `bun run test` or `bun run test:full` (runs Vitest).

## Git and GitHub Command Policy

Agents may run read-only Git and GitHub commands and routine, non-destructive write commands without asking for confirmation. This permission includes:

- Staging explicit files with `git add`.
- Creating new commits with `git commit` (but not rewriting existing commits).
- Creating branches and switching/checking out branches when doing so will not overwrite local changes.
- Pushing normally to non-protected branches without force options or deletion refspecs.
- Creating pull requests and posting pull request or issue comments.

Agents must never run destructive Git or GitHub commands. If a destructive operation is needed, stop and ask the user to perform it. Prohibited operations include:

- Discarding local work or untracked files, including `git reset`, `git clean`, `git checkout -- <path>`, `git checkout -f`, and worktree-discarding uses of `git restore`.
- Rewriting history, including `git commit --amend`, `git rebase`, history-filtering commands, and reflog expiration or aggressive pruning.
- Force-pushing by any mechanism, deleting remote refs, using mirror pushes, or pushing directly to `main` or `master`.
- Deleting branches, tags, stashes, worktrees, remotes, repositories, releases, or comments.
- Merging or closing pull requests or issues, changing repository visibility, or modifying repository access, branch protection, secrets, or other security settings.

When a command is ambiguous or combines safe and destructive behavior, do not run it; use a narrower non-destructive command or ask the user.

## Project Snapshot

T3 Code is a minimal web GUI for using code agents like Codex and Claude Code (coming soon).

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.

## Codex App Server (Important)

T3 Code is currently Codex-first. The server starts `codex app-server` (JSON-RPC over stdio) per provider session, then streams structured events to the browser through WebSocket push messages.

How we use it in this codebase:

- Session startup/resume and turn lifecycle are brokered in `apps/server/src/codexAppServerManager.ts`.
- Provider dispatch and thread event logging are coordinated in `apps/server/src/providerManager.ts`.
- WebSocket server routes NativeApi methods in `apps/server/src/wsServer.ts`.
- Web app consumes orchestration domain events via WebSocket push on channel `orchestration.domainEvent` (provider runtime activity is projected into orchestration events server-side).

Docs:

- Codex App Server docs: https://developers.openai.com/codex/sdk/#app-server

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.
