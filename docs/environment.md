# Environment variables

This file is the source of truth for F5's environment-variable surface. A drift test asserts that the table below and `turbo.json`'s `globalEnv` stay in sync; if you add, rename, or remove a variable, update both.

Prefer `F5_*` variables for F5-owned state. The legacy `T3CODE_*` prefix remains supported for upstream compatibility (see [NOTICE.md](../NOTICE.md)).

| Variable                         | Description                                                  |
| -------------------------------- | ------------------------------------------------------------ |
| `F5_HOME`                        | Base directory for F5 state; defaults to `~/.f5`             |
| `F5_STATE_DIR`                   | Directory for persistent state; defaults to `~/.f5/userdata` |
| `F5_PORT_OFFSET`                 | Dev-runner port offset alias                                 |
| `F5_DEV_INSTANCE`                | Dev-runner deterministic port-offset seed                    |
| `T3CODE_PORT`                    | Server port                                                  |
| `T3CODE_MODE`                    | Operating mode                                               |
| `T3CODE_AUTH_TOKEN`              | Authentication token for WebSocket connections               |
| `T3CODE_HOME`                    | Legacy base directory override                               |
| `T3CODE_STATE_DIR`               | Legacy state directory override                              |
| `T3CODE_PORT_OFFSET`             | Legacy dev-runner port offset                                |
| `T3CODE_DEV_INSTANCE`            | Legacy dev-runner deterministic port-offset seed             |
| `T3CODE_NO_BROWSER`              | Skip auto-opening the browser on start                       |
| `T3CODE_LOG_WS_EVENTS`           | Enable verbose WebSocket event logging                       |
| `T3CODE_LOG_THREAD_OPEN_TIMINGS` | Log per-thread open timing diagnostics                       |
| `T3CODE_LOG_PROJECTION_TIMINGS`  | Log orchestration projection timing diagnostics              |
| `T3CODE_OBSERVABILITY_ENABLED`   | Enable local ndjson trace/metrics export                     |
| `T3CODE_DESKTOP_WS_URL`          | WebSocket URL override (used by the desktop app)             |
| `PORT`                           | Fallback HTTP port (used when `T3CODE_PORT` unset)           |
| `ELECTRON_RENDERER_PORT`         | Port for the Electron renderer dev server                    |
| `VITE_WS_URL`                    | WebSocket URL for the web frontend (dev)                     |
| `VITE_DEV_SERVER_URL`            | Vite dev server URL for proxy mode                           |

## State separation from T3 Code

F5 defaults to `~/.f5/userdata/state.sqlite`. On first run, if that database is missing and the legacy shared `~/.t3/userdata/state.sqlite` exists, F5 copies the legacy state into the active F5 userdata directory (`~/.f5/userdata` by default, or `<F5_HOME>/userdata` / `<T3CODE_HOME>/userdata` when a home override is set) and then runs F5 migrations only against the copy. Explicit `F5_STATE_DIR` / `T3CODE_STATE_DIR` overrides do not trigger automatic legacy migration; unset the override and restart F5 to opt into migration later, or copy the legacy state directory manually while F5 is stopped.

F5 refuses to use `~/.t3/userdata` as its active state directory. F5 never deletes or mutates `~/.t3/userdata` during this migration. To make original T3 Code open a clean database again after F5 has copied your state, move or restore `~/.t3/userdata` yourself, then launch T3 Code so it can recreate its own schema.

If the automatic copy fails, F5 logs the error, writes `.legacy-t3-migration-failed.json` in the F5 userdata directory, and starts with an empty F5 database. To retry the automatic migration, stop F5, remove the empty F5 userdata directory or the failure sentinel, then start again with no explicit state-directory override.
