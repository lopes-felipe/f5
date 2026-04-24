# Environment variables

This file is the source of truth for F5's environment-variable surface. A drift test asserts that the table below and `turbo.json`'s `globalEnv` stay in sync; if you add, rename, or remove a variable, update both.

Variables currently ship under the legacy `T3CODE_*` prefix for backwards compatibility (see [NOTICE.md](../NOTICE.md)).

| Variable                         | Description                                          |
| -------------------------------- | ---------------------------------------------------- |
| `T3CODE_PORT`                    | Server port                                          |
| `T3CODE_MODE`                    | Operating mode                                       |
| `T3CODE_AUTH_TOKEN`              | Authentication token for WebSocket connections       |
| `T3CODE_STATE_DIR`               | Directory for persistent state (SQLite, attachments) |
| `T3CODE_NO_BROWSER`              | Skip auto-opening the browser on start               |
| `T3CODE_LOG_WS_EVENTS`           | Enable verbose WebSocket event logging               |
| `T3CODE_LOG_THREAD_OPEN_TIMINGS` | Log per-thread open timing diagnostics               |
| `T3CODE_LOG_PROJECTION_TIMINGS`  | Log orchestration projection timing diagnostics      |
| `T3CODE_OBSERVABILITY_ENABLED`   | Enable local ndjson trace/metrics export             |
| `T3CODE_DESKTOP_WS_URL`          | WebSocket URL override (used by the desktop app)     |
| `PORT`                           | Fallback HTTP port (used when `T3CODE_PORT` unset)   |
| `ELECTRON_RENDERER_PORT`         | Port for the Electron renderer dev server            |
| `VITE_WS_URL`                    | WebSocket URL for the web frontend (dev)             |
| `VITE_DEV_SERVER_URL`            | Vite dev server URL for proxy mode                   |
