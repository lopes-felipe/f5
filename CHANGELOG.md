# Changelog

All notable changes to F5 are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) for the published CLI (`t3`) and the desktop app.

## [Unreleased]

### Added

- `NOTICE.md`, `ARCHITECTURE.md` (root stub), `SECURITY.md`, `CODE_OF_CONDUCT.md`, and `THIRD_PARTY_LICENSES.md` at the repository root.
- `docs/provider-prerequisites.md` covering both Codex and Claude Code install/auth.
- Documentation index at `docs/README.md`.
- Drift test comparing the README env-var table against `turbo.json` `globalEnv`.

### Changed

- README rewritten with user-first framing (download links, explicit provider auth commands, install/run matrix).
- `CONTRIBUTING.md` restructured so "how to run / test / ship" appears before the triage policy.
- `AGENTS.md` adds a Repository map section and now mentions both Codex and Claude Code.
- `docs/release.md` updated to reference the `lopes-felipe/f5` repo and document the legacy `t3`/`T3CODE_*` identifier policy.
- Stale docs under `docs/` (formerly `.docs/`) rewritten to name F5 and both providers (Codex + Claude Code).

### Moved

- Internal `.docs/` directory promoted to `docs/` so GitHub renders it in the repository sidebar.

---

The first public release will populate this file with a `vX.Y.Z — YYYY-MM-DD` section and begin tagging entries accordingly.
