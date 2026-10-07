# Contributing

## Read This First

We are not actively accepting contributions right now.

You can still open an issue or PR, but please do so knowing there is a high chance we close it, defer it forever, or never look at it.

If that sounds annoying, that is because it is. This project is still early and we are trying to keep scope, quality, and direction under control.

PRs are automatically labeled with a `vouch:*` trust status and a `size:*` diff size based on changed lines.

If you are an external contributor, expect `vouch:unvouched` until we explicitly add you to [.github/VOUCHED.td](.github/VOUCHED.td).

## What We Are Most Likely To Accept

Small, focused bug fixes.

Small reliability fixes.

Small performance improvements.

Tightly scoped maintenance work that clearly improves the project without changing its direction.

## What We Are Least Likely To Accept

Large PRs.

Drive-by feature work.

Opinionated rewrites.

Anything that expands product scope without us asking for it first.

If you open a 1,000+ line PR full of new features, we will probably close it quickly and remember that you ignored the clearly written instructions.

## If You Still Want To Open A PR

Keep it small.

Explain exactly what changed.

Explain exactly why the change should exist.

Do not mix unrelated fixes together.

If the PR makes anything resembling a UI change, include clear before/after images.

If the change depends on motion, timing, transitions, or interaction details, include a short video.

If we have to guess what changed, we are much less likely to review it.

## Issues First

If you are thinking about a non-trivial change, open an issue first.

That still does not mean we will want the PR, but it gives you a chance to avoid wasting your time.

## Be Realistic

Opening a PR does not create an obligation on our side.

We may close it. We may ignore it. We may ask you to shrink it. We may reimplement the idea ourselves later.

If you are fine with that, proceed.

## Harness version bumps

Pin runtime versions; do not certify floating latest. Before merging a Claude SDK or
Codex app-server bump:

- Run `bun run sdk:audit`, `bun run protocol:audit:baseline`, and
  `bun run protocol:audit:requests:baseline`; classify every new message/discriminator
  and review deprecated SDK references.
- Run `bun run --cwd apps/server test:claude:live` with authenticated Claude credentials.
  Report missing credentials as unverified, never as a passing live check.
- Run the Codex rewind matrix: 0.144.3 smoke, 0.147 rollback, 0.156 legacy-history fork,
  and 0.160.1 new-history revert, each followed by a model turn. Preserve executable
  overrides and use isolated provider homes. `apps/server/scripts/certify-codex-rewind.ts` runs
  the model-backed manager check; `F5_CODEX_RESUME_BINARY` selects the legacy-history
  upgrade leg. Run the native startup smoke too.
- Run `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test:full`.
- Update `docs/providers/claude.md` and `docs/providers/codex.md` with versions, source
  revisions, spike outcomes and any unverified checks. Apply the wire-version policy
  when decoded browser shapes change.

Audit research covers Claude SDK 0.2.113–0.3.292 and Codex 0.89.0–0.160.1. Earlier
versions are checked only for a specifically retained behavior, and recorded explicitly.
Release 0 keeps the browser queue contract and wire protocol unchanged; submission
provenance is stamped and stored solely on the server.
