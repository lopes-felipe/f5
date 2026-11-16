# Workspace layout

> Contributors: one line per package in the monorepo.

- `/apps/server`: Node.js WebSocket server. Hosts the provider adapters and orchestration engine and serves the built web app.
- `/apps/web`: React + Vite UI. Session control, conversation, and provider event rendering. Connects to the server via WebSocket.
- `/apps/desktop`: Electron shell. Spawns a desktop-scoped backend process and loads the shared web app.
- `/apps/marketing`: Astro static marketing site with download links and release info.
- `/packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types.
- `/packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@t3tools/shared/git`, `@t3tools/shared/DrainableWorker`) with no barrel index.
- `/packages/effect-acp`: Agent Client Protocol (ACP) client built on Effect, used by the Cursor, Grok and Antigravity adapters.
