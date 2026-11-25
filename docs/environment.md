# Environment variables

> Operators and contributors: every environment variable F5 reads.

This file is the source of truth for F5's environment-variable surface. A drift test asserts that the table below and `turbo.json`'s `globalEnv` stay in sync; if you add, rename, or remove a variable, update both.

Prefer `F5_*` variables for F5-owned state. The legacy `T3CODE_*` prefix remains supported for upstream compatibility (see [NOTICE.md](../NOTICE.md)).

| Variable                                 | Description                                                                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `F5_MODE`                                | Operating mode (`web` or `desktop`; overrides `T3CODE_MODE`)                                                                        |
| `F5_PORT`                                | Server port (overrides `T3CODE_PORT`)                                                                                               |
| `F5_HOST`                                | Bind interface/address (overrides `T3CODE_HOST`)                                                                                    |
| `F5_NO_BROWSER`                          | Skip auto-opening the browser on start (overrides `T3CODE_NO_BROWSER`)                                                              |
| `F5_AUTH_TOKEN`                          | Authentication token for remote HTTP and WebSocket connections (overrides `T3CODE_AUTH_TOKEN`)                                      |
| `F5_LOG_WS_EVENTS`                       | Enable verbose WebSocket event logging (overrides `T3CODE_LOG_WS_EVENTS`)                                                           |
| `F5_LOG_THREAD_OPEN_TIMINGS`             | Log per-thread open timing diagnostics (overrides `T3CODE_LOG_THREAD_OPEN_TIMINGS`)                                                 |
| `F5_LOG_PROJECTION_TIMINGS`              | Log orchestration projection timing diagnostics (overrides `T3CODE_LOG_PROJECTION_TIMINGS`)                                         |
| `F5_OBSERVABILITY_ENABLED`               | Enable local ndjson trace/metrics export (overrides `T3CODE_OBSERVABILITY_ENABLED`)                                                 |
| `F5_COALESCE_STREAMING_DELTAS`           | Set to `false` before server startup to disable Codex streaming delta batching independently of workflow summary/storage changes    |
| `F5_AUTO_BOOTSTRAP_PROJECT_FROM_CWD`     | Auto-create a project from the server's working directory on startup (overrides `T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD`)           |
| `F5_WEB_SOURCEMAP`                       | Enable Vite sourcemaps during web builds (overrides `T3CODE_WEB_SOURCEMAP`)                                                         |
| `F5_HOME`                                | Base directory for F5 state; defaults to `~/.f5`                                                                                    |
| `F5_GITHUB_OAUTH_CLIENT_ID`              | GitHub OAuth app for browser sign-in; defaults to GitHub CLI's public app, empty disables it                                        |
| `F5_PROFILE`                             | Profile slug or id; defaults to `default`. Each profile runs its own server.                                                        |
| `F5_STATE_DIR`                           | Directory for persistent state; defaults to `~/.f5/userdata`                                                                        |
| `F5_PORT_OFFSET`                         | Dev-runner port offset alias                                                                                                        |
| `F5_DEV_INSTANCE`                        | Dev-runner deterministic port-offset seed                                                                                           |
| `F5_COMPOSER_REDESIGN`                   | Composer redesign (attached state drawers, scroll collapse); on by default, `0` disables it                                         |
| `F5_BACKUP_MAX_COMPRESSED_BYTES`         | Maximum compressed restore upload; defaults to 2 GiB                                                                                |
| `F5_BACKUP_MAX_DECOMPRESSED_BYTES`       | Maximum decompressed restore archive; defaults to 8 GiB                                                                             |
| `F5_BACKUP_MAX_TEMPORARY_BYTES`          | Maximum combined restore staging footprint; defaults to 16 GiB                                                                      |
| `F5_BACKUP_MAX_EXPANSION_RATIO`          | Maximum gzip expansion ratio; defaults to 200×                                                                                      |
| `F5_BACKUP_MIN_FREE_BYTES`               | Free disk space restore staging leaves; defaults to 512 MiB                                                                         |
| `F5_RELEASE_REPOSITORY`                  | Marketing site build: GitHub `owner/name` for download links; defaults to `lopes-felipe/f5`                                         |
| `F5_TRUSTED_PROXIES`                     | Reverse proxies whose `X-Forwarded-For` is believed: comma-separated IP addresses or CIDR ranges (see [REMOTE.md](../REMOTE.md))    |
| `T3CODE_PORT`                            | Legacy alias for `F5_PORT`                                                                                                          |
| `T3CODE_MODE`                            | Legacy alias for `F5_MODE`                                                                                                          |
| `T3CODE_AUTH_TOKEN`                      | Legacy alias for `F5_AUTH_TOKEN`                                                                                                    |
| `T3CODE_HOME`                            | Legacy base directory override (`F5_HOME` wins when both are set)                                                                   |
| `T3CODE_STATE_DIR`                       | Legacy state directory override (`F5_STATE_DIR` wins when both are set)                                                             |
| `T3CODE_PORT_OFFSET`                     | Legacy dev-runner port offset                                                                                                       |
| `T3CODE_DEV_INSTANCE`                    | Legacy dev-runner deterministic port-offset seed                                                                                    |
| `T3CODE_NO_BROWSER`                      | Legacy alias for `F5_NO_BROWSER`                                                                                                    |
| `T3CODE_LOG_WS_EVENTS`                   | Legacy alias for `F5_LOG_WS_EVENTS`                                                                                                 |
| `T3CODE_LOG_THREAD_OPEN_TIMINGS`         | Legacy alias for `F5_LOG_THREAD_OPEN_TIMINGS`                                                                                       |
| `T3CODE_LOG_PROJECTION_TIMINGS`          | Legacy alias for `F5_LOG_PROJECTION_TIMINGS`                                                                                        |
| `T3CODE_OBSERVABILITY_ENABLED`           | Legacy alias for `F5_OBSERVABILITY_ENABLED`                                                                                         |
| `T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD` | Legacy alias for `F5_AUTO_BOOTSTRAP_PROJECT_FROM_CWD`                                                                               |
| `T3CODE_WEB_SOURCEMAP`                   | Legacy alias for `F5_WEB_SOURCEMAP`                                                                                                 |
| `T3CODE_TELEMETRY_ENABLED`               | Set to `false` to force anonymous usage telemetry off even when a key is configured                                                 |
| `T3CODE_POSTHOG_KEY`                     | PostHog project key for anonymous usage telemetry; empty by default, which disables it                                              |
| `T3CODE_POSTHOG_HOST`                    | PostHog ingestion host; defaults to `https://us.i.posthog.com`                                                                      |
| `T3CODE_DESKTOP_WS_URL`                  | Short-lived desktop startup bootstrap URL; its token expires within 24 hours. Use the desktop bridge for a fresh URL.               |
| `F5_DISABLE_PREVIEW_PASSKEYS`            | Set to `1` and restart the desktop to disable both Touch ID configuration and the preview passkey bridge, independently of signing. |
| `PORT`                                   | Fallback HTTP port (used when `F5_PORT` and `T3CODE_PORT` are unset)                                                                |
| `ELECTRON_RENDERER_PORT`                 | Port for the Electron renderer dev server                                                                                           |
| `VITE_WS_URL`                            | WebSocket URL for the web frontend (dev)                                                                                            |
| `VITE_DEV_SERVER_URL`                    | Vite dev server URL for proxy mode                                                                                                  |

Anonymous usage telemetry is off by default. It is active only when `T3CODE_POSTHOG_KEY` is
non-empty and `T3CODE_TELEMETRY_ENABLED` is not `false`. While inactive, F5 records, buffers and
sends nothing, and does not create the telemetry identifier file.

Restore limits are enforced while streaming, before extraction, and against the combined raw plus
extracted staging footprint. F5 also reserves free space on the staging volume. Increase the caps or
reduce the reserve only when restoring a known archive that legitimately requires it.

## Secret-store filesystem requirements

Secrets live in `<stateDir>/secrets` unless a server configuration overrides `secretsDir`.
The directory uses mode `0700` and newly written files use mode `0600` on filesystems
that enforce these permissions.

`ServerSecretStore.getOrCreateRandom` requires hard-link support in that directory.
It writes and syncs a temporary file before atomically linking it to the final name,
so concurrent creators never read unfinished bytes or overwrite another creator's
secret. FAT/exFAT and some network or container mounts do not support this operation;
creation returns `SecretStoreError` there. There is deliberately no copy or direct-write
fallback because either would expose unfinished bytes again. `set` uses atomic rename
for replacement and does not require hard links. Currently, production code uses
`get`, `set`, and `remove`; random creation has no production callers.

These operations guarantee atomic visibility, not durable erasure or full power-loss
durability. The file is synced before publication, but the containing directory is
not fsynced. Normal completion, failure, and Effect interruption clean up temporary
files; a process crash can leave `<name>.bin.<uuid>.tmp` files. `remove(name)` deletes
the published file, not such crash remnants or backup copies. After stopping **all**
processes that use the directory, leftover temporary files can be removed manually.
Do not sweep them while a writer may be active: even an old temporary file may still
belong to a live or suspended write. Automated reclamation needs coordination between
writers, readers, and removers and is outside the secret-publication race fix.

## State separation from T3 Code

F5 defaults to `~/.f5/userdata/state.sqlite`. On first run, if that database is missing and the legacy shared `~/.t3/userdata/state.sqlite` exists, F5 copies the legacy state into the active F5 userdata directory (`~/.f5/userdata` by default, or `<F5_HOME>/userdata` / `<T3CODE_HOME>/userdata` when a home override is set) and then runs F5 migrations only against the copy. Explicit `F5_STATE_DIR` / `T3CODE_STATE_DIR` overrides do not trigger automatic legacy migration; unset the override and restart F5 to opt into migration later, or copy the legacy state directory manually while F5 is stopped.

F5 refuses to use `~/.t3/userdata` as its active state directory. F5 never deletes or mutates `~/.t3/userdata` during this migration. To make original T3 Code open a clean database again after F5 has copied your state, move or restore `~/.t3/userdata` yourself, then launch T3 Code so it can recreate its own schema.

If the automatic copy fails, F5 logs the error, writes `.legacy-t3-migration-failed.json` in the F5 userdata directory, and starts with an empty F5 database. To retry the automatic migration, stop F5, remove the empty F5 userdata directory or the failure sentinel, then start again with no explicit state-directory override.
