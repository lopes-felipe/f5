# Dependency patches

Root `package.json` `patchedDependencies` applies these with Bun. The desktop
build copies this directory and the entries into its staged install, then checks
that every added line is present (`verifyAppliedPatches`). A test checks that each
key matches a `bun.lock` package and that the patch file exists.

## `@effect%2Fplatform-node-shared@8881a9b.patch`

Effect's child-process spawner pipes stdin through `NodeSink`, which attached no
`error` listener and waited on `drain`/`finish` forever. A child that exited or
closed stdin before reading its input raised an uncaught `EPIPE` that crashed the
server, or hung the writer. The patch guards child stdin and input fds, and makes
`NodeSink` fail the pending write when the stream errors, closes or is destroyed.
`apps/server/src/spawn/childStdin.test.ts` covers it. Drop the patch once Effect
ships an equivalent fix.

## Regenerating a patch

`bun patch --commit` cannot find packages installed from a URL (the pkg.pr.new
Effect builds), so write the patch by hand:

1. Copy the installed package from `node_modules/.bun/<name>@<url-hash>/node_modules/<name>`
   to a scratch directory twice, as `pristine` and `work`. If a patch is already
   applied, reverse it in `pristine` first (`patch -R -p1 < <this patch>`).
2. Edit `work` (both `dist/` and `src/`).
3. `git diff --no-index pristine work`, rewrite `a/pristine/` to `a/` and
   `b/work/` to `b/`, and save the result over the patch file.
4. Key `patchedDependencies` by the exact `bun.lock` specifier, including the
   full commit URL, then run `bun install`. When the Effect pin changes, update
   the key and regenerate against the new build.
