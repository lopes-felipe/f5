# AGENTS.md

## Task Completion Requirements

- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
- Run `bun run test:full` at least once before considering a task completed. It includes the fast workspace suite and the exhaustive real-Git matrix.
- NEVER run `bun test`. Always use `bun run test` or `bun run test:full` (runs Vitest).

## Git and GitHub Command Policy

The user grants standing authorization for non-destructive Git and GitHub mutations. When the user requests an allowed operation, or an allowed operation is required to complete an explicitly requested Git/GitHub workflow, agents must execute it instead of asking for confirmation, merely explaining the command, or asking the user to run it. The request itself is sufficient authorization.

Do not treat a command as destructive merely because it changes the working tree, index, local refs, a remote feature branch, or pull request metadata. Read-only commands and non-destructive mutations are allowed. Examples include:

- Staging explicit files with `git add`, including staging requested file deletions, and safely unstaging without discarding working-tree changes.
- Creating new commits with `git commit`, plus additive history operations such as merge, cherry-pick, and revert when requested.
- Creating, renaming, and switching/checking out branches when doing so will not overwrite local changes.
- Creating and applying stashes without dropping them.
- Fetching without pruning, pulling with `--ff-only`, and pushing normally to non-protected branches without force options or deletion refspecs.
- Adding worktrees or remotes and making explicitly requested repository-local configuration changes.
- Creating or editing pull requests and issues, and posting pull request, review, or issue comments.

These examples are not an exhaustive allowlist. An operation is allowed when it preserves existing work and history, does not delete resources or refs, and does not bypass protections.

Agents must never run destructive Git or GitHub commands. If a destructive operation is needed, stop and ask the user to perform it. Prohibited operations include:

- Discarding local work or untracked files, including `git reset`, `git clean`, `git checkout -- <path>`, `git checkout -f`, and worktree-discarding uses of `git restore`.
- Rewriting history, including `git commit --amend`, `git rebase`, history-filtering commands, and reflog expiration or aggressive pruning.
- Force-pushing by any mechanism, deleting remote refs, using mirror pushes, or pushing directly to `main` or `master`.
- Deleting branches, tags, stashes, worktrees, remotes, repositories, releases, or comments.
- Merging or closing pull requests or issues, changing repository visibility, or modifying repository access, branch protection, secrets, or other security settings.

For commands with safe and destructive variants, use the safe variant rather than refusing the entire command family. For example, normal `git push` is allowed while force-push and ref deletion are prohibited; branch checkout is allowed while path checkout that discards changes is prohibited. Use targeted read-only checks to resolve uncertainty. Ask the user only when there is a concrete, unresolved risk that the operation would have a prohibited effect; generalized caution about mutation is not a reason to stop.

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
