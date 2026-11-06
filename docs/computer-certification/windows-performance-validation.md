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
