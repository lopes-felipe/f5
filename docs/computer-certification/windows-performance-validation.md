# Windows performance validation

The Windows performance follow-up adds foreground confirmation ordering, conservative
post-dispatch outcomes, deferred foreground settling, cached inspection and early-stop
element resolution. Password masking still uses its existing uncached audit traversal.

Before merge, run on an attended, unlocked Windows 11 desktop:

- Run helper and fixture cargo tests, then build the debug helper and fixture.
- Run rehearseHelperWindows.ts and the Electron Windows route using those exact artifacts.
- Verify focus/type/Enter sequencing without client sleeps, capture isolation,
  secure-value omission and stop/yield during settling.
- Compare the direct foreground app record with listApps for identity, name, tier,
  running/frontmost state and browser warning.
- Use performance-tree 380 to exercise early and late resolution. Use
  performance-password-transition between cache construction and materialization:
  names and values must be suppressed. Missing password status must fail closed.
- Compare equivalent complete inspection output, recording digests and truncation.
  Native speed acceptance requires matched baseline/candidate measurements.

Host-side Rust tests and Windows cross-compilation do not satisfy this gate.

## Matched baseline construction

Use separate clean baseline and candidate worktrees on the same attended machine.
Build both helpers in the same debug configuration. Run the **same candidate harness**
against both artifacts; running an old commit's absent or different harness is not a
matched comparison. Copy the harness/fixtures (including the lifecycle, transport,
receipt parsing and report modules) and the dependency lock into the baseline
worktree before building. Use identical prepared fixture binaries for both runs:
their executable bytes are now part of fixtureDigest.

For inspection-only comparisons, an unmodified old helper is sufficient. For task
comparisons, both builds need the common computer_batch API and telemetry hooks.
Backport that compatibility layer, and Windows focus read-back, to the baseline
without porting the settle, overlay, traversal, caching or lookup optimizations being
measured. Record this baseline compatibility patch and artifact identities with the
reports. A pre-batch product cannot run all 14 scenarios without this backport.
This is a controlled optimization comparison, not an end-to-end old-product benchmark.
Provider turn counts remain informational.

Preparation accepts helpers lacking focus verification only after an independent
inspection confirms the input's focus, outside timing. Legacy unbatched actions
still require independent exact-text/Enter receipts; explicit verification failures
always fail. Batch focus requires the compatibility read-back above.

Keep fixtureDigest, harnessDigest, dependency lock, displays, masking, build and
execution mode identical. Helper/desktop identities may differ. Never edit report
digests to force a comparison. A failed, partial or incompatible run supplies no
performance acceptance. Inspection coverage deliberately includes the planned
30% macOS / 25% Windows improvement gate, not just a non-regression check.
