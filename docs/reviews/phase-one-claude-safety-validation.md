# Phase 1c: Claude metadata and interaction safety

Based on merged PR #37 (`8e3d9acc4c`). This PR implements seven of the 77 Phase 1c records. The other 70 remain deferred; this is not completion of Phase 1c or the upstream port program.

## Changes

- `95834d68a`: All Claude metadata generation runs in a scoped temporary directory with hooks disabled, no ordinary tools, no slash commands, strict MCP configuration, and normal permission checks. Custom executable paths resolve against the caller's working directory before switching directories. The explicit instance environment is passed without merging another ambient environment back in.
- `52b2bf77a`: Decode both object and verbose-array structured-output envelopes, selecting the last result message, and unwrap JSON-encoded thread titles before normalizing them.
- `18573d60a`: Put image blocks before the final prompt text, including slash-command prompts.
- `e9e46972f`: Accept-for-session rewrites every suggested permission destination to session scope. Absent or empty suggestions create a session-only rule for the requested tool. Accept-once adds no rule.
- `db02c6b9c`, `f86c5e8c8`: Capability and usage probes disable hooks, filesystem/connected MCP integrations and IDE detection while retaining settings sources needed for command discovery.
- `a5bbad910`: A model refusal fallback produces a runtime warning with the provider's explanation, or a fallback message if none was supplied.

No new settings, capabilities, database migrations or wire variants are introduced. No protocol bump is required. Model catalogs, account isolation and interactive session permission modes retain their existing behavior.

## Verification

- `bun fmt`, `bun lint`, `bun typecheck`: pass. Lint reports existing warnings and no errors.
- `F5_TEST_MAX_WORKERS=1 VITEST_MAX_WORKERS=1 bun run test:full`: pass, including 131 exhaustive real-Git tests.
- Focused metadata, probe, adapter and real-CLI integration tests pass. Coverage includes malformed envelopes, relative custom executable paths, temporary-directory cleanup on success/failure, image/slash-command ordering, session permission fallback, and warning delivery.
- `F5_REQUIRE_UPSTREAM=1 bun run upstream-ports:check`: pass after recording the implementation commit. Coverage remains 2,332 records (1,836 audited interval commits and 496 legacy commits), with no pending reviews; seven records move from planned to ported.

The real-runtime compatibility test uses the pinned SDK 0.3.280 / CLI 2.1.280 against a local synthetic Anthropic API. Through production metadata generation, the CLI advertises only `StructuredOutput`, consumes a streamed structured result, returns the expected title, and never executes a configured user `SessionStart` hook. Thus `--json-schema` works with `--tools ""`; the broader allowed-tools fallback is unnecessary. The fixture uses a temporary config directory and a synthetic key, without a real account or paid inference.

A separate authenticated CLI attempt returned `Not logged in · Please run /login` before inference. Live Anthropic service behavior and model entitlements were not verified. The existing opt-in `integration/claudeRuntime.live.test.ts` retains that coverage for an authenticated environment; its default skips are not claimed as passes.

## Remaining Claude work

The verify-first stop/background-task and continuation-home records remain deferred. Existing tests confirm cancellation of pending interactions and preservation of a session for follow-up turns; they do not prove that every background child has stopped. Upstream now interprets `homePath` as a config directory, while f5's home-based account isolation has different semantics. Neither change is marked equivalent on the strength of those partial checks. Other Claude lifecycle records and all remaining provider work still require assessment and delivery.
