# Architecture

F5 is a Bun/Turbo monorepo that ships a desktop app, a web app, and a Node.js WebSocket backend that wraps one or more coding-agent providers (Codex and Claude Code today).

```
├── apps/
│   ├── desktop     # Electron desktop app (primary distribution)
│   ├── server      # Node.js WebSocket server (published as the `t3` CLI)
│   ├── web         # React/Vite frontend
│   └── marketing   # Astro marketing site
├── packages/
│   ├── contracts   # Shared schemas and TypeScript contracts
│   └── shared      # Shared runtime utilities
└── scripts/        # Dev runner, build helpers, release tooling
```

- **`apps/desktop`** — Electron shell that spawns the backend as a child process, loads the web UI, and handles native concerns (auto-update, folder picking, the `f5://` protocol). DMG/AppImage/NSIS targets.
- **`apps/server`** — Node.js WebSocket backend. Orchestrates provider sessions, runs the event-sourced orchestration engine, manages git/PTY/MCP/skills, and serves the built web app as static assets.
- **`apps/web`** — React 19 + Vite SPA with TanStack Router. Connects to the server over WebSocket. Consumed by both the desktop app and the browser.
- **`apps/marketing`** — Astro static marketing site with download links and release info.
- **`packages/contracts`** — Schema-only package with Effect-Schema types shared between server and web.
- **`packages/shared`** — Runtime utilities consumed by both tiers via subpath exports (e.g. `@t3tools/shared/git`).

For the runtime event flow, startup readiness model, and orchestration layers, see **[docs/architecture.md](./docs/architecture.md)**. Related docs:

- [docs/provider-architecture.md](./docs/provider-architecture.md) — WebSocket protocol, provider adapter contract.
- [docs/provider-prerequisites.md](./docs/provider-prerequisites.md) — Codex + Claude Code install/auth.
- [docs/runtime-modes.md](./docs/runtime-modes.md) — Full-access vs supervised modes.
- [docs/encyclopedia.md](./docs/encyclopedia.md) — Glossary of domain terms.
- [docs/workspace-layout.md](./docs/workspace-layout.md) — One-line-per-package overview.
