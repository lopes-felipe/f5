<p align="center">
  <img src="./assets/prod/logo.svg" alt="F5" width="120" />
</p>

<h1 align="center">F5</h1>

<p align="center">
  Run coding agents against your codebase — and have them plan, review, and critique each other across models.
</p>

F5 is a desktop and web GUI for coding agents with a twist: every step of a workflow picks its own model. Mix **Codex** and **Claude Code** in a single feature-development run — two authors draft competing plans, each cross-reviews the other, a merge agent picks the winner, and an implementer executes it — each role on the provider and model you choose. The same per-slot model selection powers a dual-reviewer code-review workflow with a consolidation pass.

It is for developers who already use `codex` or `claude` on the command line and want a multi-agent, multi-model surface on top.

> [!WARNING]
> This project is very early. Expect bugs, breaking changes, and rough edges.

## Cross-model workflows

The headline capability. Each **slot** in a workflow — Author A, Author B, Merge, Implementer, Reviewer A, Reviewer B, Consolidation — independently picks its provider (Codex or Claude Code), its model, and its reasoning effort. Invoke from the command palette (`/workflow.new`) or the sidebar's **New workflow** action.

### Feature development (planning → merge → implement)

Two authors independently draft plans for the same requirement. Each **cross-reviews** the other's plan, both authors revise based on the feedback, and a **merge agent** synthesizes a single approved plan. An **implementer** then executes it — optionally in an isolated git worktree, optionally followed by a code-review pass on the resulting diff.

```mermaid
flowchart LR
    Req[Requirement] --> A[Author A<br/>model 1]
    Req --> B[Author B<br/>model 2]
    A -->|plan A| RB[Review<br/>by B]
    B -->|plan B| RA[Review<br/>by A]
    RA --> A2[Revise A]
    RB --> B2[Revise B]
    A2 --> M[Merge agent<br/>model 3]
    B2 --> M
    M --> I[Implementer<br/>model 4]
    I -. optional .-> CR[Code review]
```

Why it matters: two models catch blind spots a single model would miss, you can pair a fast planner with a strong implementer, and the merge agent arbitrates between competing approaches instead of leaving that to you.

### Code review (dual reviewer → consolidation)

Two reviewers independently review the current branch, then a **consolidation** agent merges their findings into a single ranked report — each agent on its own model.

```mermaid
flowchart LR
    Branch[Current branch<br/>diff] --> RA[Reviewer A<br/>model 1]
    Branch --> RB[Reviewer B<br/>model 2]
    RA --> C[Consolidation<br/>model 3]
    RB --> C
    C --> Report[Unified review]
```

Why it matters: reviewers disagree in useful ways; the consolidation pass dedupes findings, resolves contradictions, and ranks what's worth your attention.

## Install & run

### Desktop app from source (recommended)

```bash
bun install
bun run build:desktop
bun run start:desktop
```

Full source-build recipes: [`docs/quick-start.md`](./docs/quick-start.md).

### From npm (web UI)

No install needed:

```bash
npx t3
```

This runs the bundled WebSocket server and opens the web UI in your browser. The published package is named `t3` for backwards compatibility — see [Relationship to upstream](#relationship-to-upstream).

### Download

Work in-progress

## Prerequisites

- [Bun](https://bun.sh/) ≥ 1.3.9
- [Node.js](https://nodejs.org/) ≥ 24.13.1
- At least one authenticated provider CLI:
  - [Codex CLI](https://github.com/openai/codex) — `codex login`
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — `claude login`

See [`docs/provider-prerequisites.md`](./docs/provider-prerequisites.md) for provider-specific setup.

## Also included

- **Multi-provider chat** — Codex and Claude Code as first-class providers, switchable per thread.
- **MCP support** — stdio, SSE, and streamable HTTP transports with per-project and shared scopes, OAuth, and tool filtering.
- **Project Skills** — user- and project-scoped skills surfaced to agents and triggerable from the composer.
- **Git integration** — branches, worktrees, diffs (`@pierre/diffs`), PR helpers, stacked-action runners.
- **Integrated terminal** — PTY-backed xterm.js terminals attached to the project.
- **File view panel** — inline file viewer with line/column navigation and "open in external editor" hand-off.
- **Token & context tracking** — per-thread, per-session, per-model, persisted server-side.
- **Customizable keybindings** — see [`KEYBINDINGS.md`](./KEYBINDINGS.md).

Full change history vs. upstream: [`CHANGELOG.md`](./CHANGELOG.md). Architecture deep-dive: [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Architecture at a glance

```
├── apps/
│   ├── desktop     # Electron app (primary distribution)
│   ├── server      # Node.js WebSocket server (published as the `t3` CLI)
│   ├── web         # React 19 / Vite frontend
│   └── marketing   # Astro marketing site
├── packages/
│   ├── contracts   # Shared Effect-Schema types
│   └── shared      # Shared runtime utilities
└── scripts/        # Dev runner, build helpers, release tooling
```

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`docs/architecture.md`](./docs/architecture.md) for the runtime event flow, orchestration layers, and provider adapter contract.

## Configuration

The `T3CODE_*` prefix is inherited from the upstream T3 Code project and is retained for backwards compatibility — see [`NOTICE.md`](./NOTICE.md). Full reference: [`docs/environment.md`](./docs/environment.md).

## Documentation

- [`docs/quick-start.md`](./docs/quick-start.md) — one-liner recipes for dev, build, and dist
- [`docs/architecture.md`](./docs/architecture.md) — runtime, orchestration, persistence
- [`docs/provider-architecture.md`](./docs/provider-architecture.md) — WebSocket protocol, adapter contract
- [`docs/provider-prerequisites.md`](./docs/provider-prerequisites.md) — Codex + Claude Code install and auth
- [`docs/runtime-modes.md`](./docs/runtime-modes.md) — full-access vs. supervised modes
- [`docs/encyclopedia.md`](./docs/encyclopedia.md) — glossary of domain terms
- [`docs/workspace-layout.md`](./docs/workspace-layout.md) — one-line package overview
- [`docs/environment.md`](./docs/environment.md) — full env-var reference
- [`docs/release.md`](./docs/release.md) — release process
- [`KEYBINDINGS.md`](./KEYBINDINGS.md) — default keybindings and how to customize
- [`REMOTE.md`](./REMOTE.md) — running F5 on a remote host
- [`SECURITY.md`](./SECURITY.md) — reporting vulnerabilities
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — contribution policy

## Relationship to upstream

F5 is an opinionated fork of [T3 Code](https://github.com/pingdotgg/t3code) by [@pingdotgg](https://github.com/pingdotgg). It keeps the upstream's MIT license and retains a handful of legacy identifiers (the `t3` npm package, `@t3tools/*` workspace names, `T3CODE_*` environment variables) so existing installations keep working. See [`NOTICE.md`](./NOTICE.md) for the full list and [`CHANGELOG.md`](./CHANGELOG.md) for what F5 adds on top.

## Community

Need help or want to follow along? Join the [Discord](https://discord.gg/jn4EGJjrvv).

## Contributing

We are not actively accepting contributions. Small, focused bug fixes and reliability improvements are most likely to be reviewed. Details in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
