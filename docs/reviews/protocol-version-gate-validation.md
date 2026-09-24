# Phase 0c protocol gate validation

This change introduces protocol version 1, admission checks, authenticated capability
and limit metadata, and upload-aware reload handling. Wire behavior and the first
rollout limitation are documented in `docs/protocol-versioning.md`. It leaves the
frozen upstream ledger unchanged; the full Phase 0b classification is still pending.

## Focused coverage

The server suite exercises missing, older, future, and repeated protocol query
parameters. Each rejected authenticated socket attempts an RPC and receives zero
application messages before closing with 4426. A compatible reconnect receives the
current bootstrap metadata. HTTP tests verify authenticated metadata, 426 on stale
backup uploads, the current-version path, and no-cache HTML after assets change.

Client tests verify version parameters on reconnect, preservation of authentication
parameters, refusal to retry after an upgrade close, pending-request rejection,
welcome metadata application before subscribers run, refreshed limits, protocol
headers, and no automatic mutation retry after 426. The browser test verifies the
upgrade message even when the disconnect overlay is disabled, preservation of the
mounted draft input, and waiting for active uploads before reload.

## Baseline failures encountered

The first full-suite run failed the existing reachable-loopback OAuth preflight
test, which uses a 20 ms deadline. That test passed in isolation. No OAuth code,
timeout, or test was changed in this PR. A subsequent complete run passed after
browser installation and other checks had finished. This is not a claim that the
intermittent socket-test failure is fixed.

The browser suite initially lacked Chromium. Its installation stalled during
extraction under Node 26; installation with CI's Node 24.13.1 succeeded.

The first browser run passed 421 tests and failed the existing rich-assistant-row
layout measurement. It failed again in isolation because the adjacent row was
outside the virtualized rendered window. The fixture now puts the measured pair
near the timeline end and uses initial end scrolling, following the neighboring
nested-work-group test. Its original overlap assertion is unchanged. This fixture
fix is separated from the protocol implementation in its own commit.

## Final checks

- `bun fmt`, `bun lint` (eight existing warnings), `bun typecheck`, and
  `git diff --check`: passed.
- `F5_REQUIRE_UPSTREAM=1 bun run upstream-ports:check`: passed for the existing
  500-entry window; this is not the unfinished 1,836-SHA classification.
- `bun run test:full`: all seven workspace tasks passed, including 2,367 server
  unit tests, 1,607 web unit tests, 8 Git smoke tests, 13 server integration tests,
  and all 107 exhaustive Git tests.
- `bun run --cwd apps/web test:browser`: all 422 tests passed.
- `bun run test:desktop-smoke`: passed.
- `bun run test:profiles-smoke`: passed against built backends, including the
  protocol-aware connection and authenticated bootstrap flow.

Tests ran on macOS arm64. Browser installation used Node 24.13.1; application checks
used the normal Node 26.9.0/Bun 1.3.11 environment. Platform-specific CI remains
necessary; no Linux or Windows packaged-run result is claimed here.

## Review follow-up

Send waits for welcome metadata, and the send handler resolves limits before taking
its lock. Missing image-import limits return visible failures. Missing or mismatched
welcome metadata closes the socket without reconnecting. The optional schema field
allows legacy welcomes to reach this explicit rejection path.

Automatic reload requires completed image imports and verified draft persistence.
A recovery download includes in-memory image data URLs; manual reload warns before
interrupting uploads or discarding unsaved attachments. A session-storage marker
limits automatic reload to one attempt per client version. Global advertised limits
use the same constants as server enforcement; provider-specific limits are deferred
until provider-specific enforcement exists.

Follow-up validation passed: formatting, lint (eight existing warnings), typecheck,
the full workspace suite and all 107 extended Git tests, all 429 browser tests,
desktop smoke, and the upstream ledger check with `F5_REQUIRE_UPSTREAM=1`.
The browser fixtures now include current bootstrap metadata. Tests cover absent
limits, import/serialization/storage failure with the real draft store, recovery
image bytes, repeat reloads, manual reload warnings, and explicit HTTP 400 for an
invalid restore request with the current protocol header.
