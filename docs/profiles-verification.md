# Profiles implementation verification

This records checks against the current working tree, not a release certification. The real-provider release gate in [profiles.md](profiles.md#real-provider-release-gate) remains pending.

## Automated checks

| Check                                            | Result                                                                                                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun fmt`                                        | Passed                                                                                                                                              |
| `bun lint`                                       | Passed; six warnings, no errors                                                                                                                     |
| `bun typecheck`                                  | Passed in all eight workspaces                                                                                                                      |
| `bun run test:full`                              | Failed: ten Windows `EPERM` errors creating symlinks; 2,259 server tests passed, nine skipped; the other six workspace tasks passed                 |
| Web unit tests                                   | 1,565 passed                                                                                                                                        |
| Desktop unit tests                               | 102 passed                                                                                                                                          |
| Shared unit tests                                | 364 passed                                                                                                                                          |
| Contracts tests                                  | 199 passed                                                                                                                                          |
| `bun run --cwd apps/web test:browser`            | 394 passed across 41 files                                                                                                                          |
| `bun run test:desktop-smoke`                     | Passed                                                                                                                                              |
| `bun run test:server:git:extended`               | 107 passed                                                                                                                                          |
| `bun run test:server:integration`                | 13 passed, five skipped                                                                                                                             |
| Focused GitHub account/API/Git environment tests | 42 passed                                                                                                                                           |
| `bun run test:profiles-smoke`                    | Passed with real built server processes and a temporary Git repository                                                                              |
| `bun run upstream-ports:check`                   | Ledger passed: 500 frozen commits and 12 older categories; authoritative-remote provenance check skipped because that remote is unavailable locally |
| `git diff --check`                               | Passed                                                                                                                                              |

The full-suite failures occur in WorkspaceAssetAuthorizer, projectFaviconRoute, wsServer, CheckedInProjectFileService and StorageMaintenance tests. This Windows session cannot create their symlinks. These tests remain enabled. A runner with symlink support must run the full command successfully before completion can be claimed. The extended Git suite was run separately because the full command stops after the unit-suite failure.

## Runtime and code review

The checked-in `scripts/profile-lifecycle-smoke.cjs` verifies simultaneous Default and Work backends, different welcome identities and state directories, occupied-port exit 78 without fallback, duplicate-instance exit 78, rejection of live removal, movement to trash after stopping, explicit-selection failure for a corrupt registry, and Default diagnostic fallback that refuses mutations without rewriting the corrupt file. It also saves Work's Git author through the real WebSocket settings route, commits through the managed Git RPC, and checks the resulting author against a conflicting repository-local identity. Ubuntu and Windows CI run this smoke after building the server.

Review found and fixed a missing Git-author update schema, an ineffective Codex file-credential override that was being discarded by the launch-argument sanitizer, account-panel completion races, registry mutation markers left behind after a crash, and push-schema test generators that could hang or reject unsupported regular expressions. Regression coverage includes the transport fields, trusted Codex command construction, real-process registry guard recovery and decoding through every push channel.

Two safety adjustments differ from the original plan: retired ports remain reserved permanently, and the short-lived exclusive registry marker is protected by an OS-held SQLite guard. These prevent eventual browser-storage reuse and make crash recovery possible without stealing a live writer's lock.

## Outstanding release evidence

Dedicated Codex, Claude and GitHub accounts and Windows, macOS and Linux test environments are needed for the authenticated acceptance matrix. No authenticated acceptance result is claimed here. In particular, distinct Claude macOS keychain identities, credential refresh/logout independence, subscription versus API billing, untouched host credential stores, authenticated fetch/push identity, and the complete desktop manual workflow still require recorded runs. The macOS CI storage tests do not certify keychain isolation.

## Review follow-up

The review fixes and their rationale are recorded in [profiles-review.md](profiles-review.md). The latest runs pass formatting, lint, all eight typecheck workspaces, all 394 browser tests, 107 extended Git tests and 13 integration tests (five skipped). The full suite has the same ten Windows symlink-permission failures, with 2,259 server tests passing; no tests were disabled to hide these failures.

The real backend lifecycle smoke now shares one cookie jar between two authenticated profiles on the same hostname, verifies independent logout, and invokes the bundled Claude account-status command in a fresh isolated home. That home reports unauthenticated. This exercises the packaged certification path; it does not replace the dedicated-account cross-platform release gate.
