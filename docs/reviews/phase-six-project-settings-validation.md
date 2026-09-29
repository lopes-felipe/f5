# Phase 6 project-scoped settings validation

Implements the approved seven scoped server settings, checked-in configuration resolution, defaults for new drafts, submodule policy, project settings UI and client preference migration. Account isolation, explicit thread permissions, provider catalogs, Plan mode, queues and workflows retain their existing behavior.

Protocol version: **9**. See [Project settings](../user/project-settings.md) for precedence, defaults and migration behavior.

Tests cover precedence (including explicit false/null), whole-object replacement and reset, legacy settings decoding, concurrent client migration, bounded/symlink-safe configuration reads, project RPCs and deletion cleanup, scoped Git metadata generation, submodule arguments and failure handling, concurrent thread streaming, draft model precedence, browser migration and the project settings UI.

All required gates passed on macOS with Bun 1.3.11. The browser suite passed **500 tests across 52 files**; the exhaustive real-Git matrix passed **133 tests**. Lint reports 10 pre-existing warnings and no errors.

Validation commands:

- `bun fmt`
- `bun lint`
- `bun typecheck`
- `env -u F5_PROFILE_ISOLATED -u GIT_CONFIG_COUNT bun run test:full`
- `bun run --cwd apps/web test:browser`
- `F5_REQUIRE_UPSTREAM=1 bun run upstream-ports:check`

The test command removes the host agent's injected profile/Git configuration so disposable repository fixtures use their own configuration. Real Git mutation tests use temporary repositories. Browser tests use synthetic server fixtures; the WebSocket integration test exercises the real server's project resolution, updates and pruning.

No benchmark threshold is changed by this PR. It does not claim a performance improvement or implement the remaining Phase 2 work.
