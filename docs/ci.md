# CI quality gates

- `.github/workflows/ci.yml` runs `bun run fmt:check`, `bun run lint`, `bun run typecheck`, and `bun run test:full` for pull requests and pushes to `main`.
- Use the fast `bun run test` suite for local feedback; CI runs the extended real-Git matrix before a change can merge.
- Agents and contributors must run `bun run test:full` at least once before declaring work complete. It is also required before releases and after major Git subsystem changes.
- `.github/workflows/release.yml` builds macOS (`arm64` and `x64`), Linux (`x64`), and Windows (`x64`) desktop artifacts from a single `v*.*.*` tag and publishes one GitHub release.
- The release workflow auto-enables signing only when secrets are present: Apple credentials for macOS and Azure Trusted Signing credentials for Windows. Without secrets, it still releases unsigned artifacts.
- See `docs/release.md` for full release/signing setup checklist.
