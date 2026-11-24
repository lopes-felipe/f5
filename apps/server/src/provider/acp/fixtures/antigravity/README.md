# Antigravity capture fixtures

Committed fixtures hold only the allowlisted projection produced by
`projectAntigravityCapture` (`../../AntigravityCapture.ts`): mode IDs, option IDs and values,
command names, permission kinds and field presence. They never contain account identity, paths,
prompt text or `_meta` values.

- `upstream-initialize.fixture.json` is derived from upstream T3 Code; `meta.upstream` records
  the commit and file.
- Live fixtures are produced by the user with
  `bun apps/server/scripts/acp-capability-probe.ts --antigravity-session ...` (see the script
  header). Each records the agy version, platform, auth method, account tier and date.

Features gated on R0 stay unexposed until the matching live fixture is committed and its gate is
recorded under `docs/reviews/`.
