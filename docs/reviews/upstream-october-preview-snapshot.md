# Preview snapshot secret protection

This records the cross-frame portion of upstream #20446. Its delivery record
remains deferred until native Electron verification is complete. Settings and
provider-initialization privacy checks are recorded below.

The previous implementation collected protected fields only in the main frame.
The new regression suite reproduced child credentials escaping in reflected text
and diagnostics. It also reproduced the truncation boundary case.

The capture now reads protected fields in isolated worlds for every native frame,
before and after taking the page snapshot. Native frame identities and CDP document
loader identities must remain unchanged. A changed field permits one retry;
values observed during either attempt remain masked. Text is truncated only after
the final host-side redaction. JSON, quoted and CSS-escaped selector variants are included, while
host-defined field names retain the snapshot schema.

Chromium omits remote frames from some process-local Page trees. Missing iframe
targets are attached only after `DOM.getFrameOwner` proves that their owner is
inside an already inspected DOM. Chromium's implementation explicitly traverses
from the inspected root when resolving that owner; see
[InspectorDOMAgent::getFrameOwner](https://chromium.googlesource.com/chromium/src/+/ce81daff97e71c8b44fdf16eda2e2b5b21df0151/third_party/blink/renderer/core/inspector/inspector_dom_agent.cc).
There is no main-world fallback and no attachment to ordinary page targets.

The operation has a ten-second total deadline, at most two captures, 256 frames,
4,096 protected values and 1,048,576 retained protected characters. A timed-out
renderer request retains its per-guest slot until it actually settles, preventing
repeated requests from accumulating. Only child sessions created by this capture
are detached, including attachments that answer after the deadline. The shared
root debugger remains attached.

The renderer transfers only the visible-text prefix plus enough lookahead for
the longest supported serialized credential. Literal forms are matched in one
pass. A pattern the runtime cannot compile fails with a generic, payload-free
error rather than printing the protected regular expression.

## Verification

- All 34 snapshot extraction/frame tests pass, including hidden child secrets,
  changing values, document replacement, inserted frames, unrelated page targets,
  an omitted remote frame, hung requests and late attachment cleanup.
- All 558 desktop unit tests pass.
- `bun run --cwd apps/desktop test:preview-snapshot:browser` passes in Chromium.
  It uses nested cross-origin frames in separate renderer processes, a page that
  replaces its input-value getter, a shadow-root password, CSS-masked editable
  content, diagnostics and text crossing the truncation boundary. An unrelated
  page supplies additional iframe targets; they are never attached. Child sessions
  are released. The production snapshot module is bundled for this test.
- Native Electron 40.6.0 was version-checked and launched with temporary user data
  and the same fixture. Both GUI launches aborted with SIGABRT and no test result.
  Native verification therefore remains failed, rather than being inferred from
  the Chromium adapter or unit tests. No existing profile was opened or changed.

The native check is available without downloading or selecting a different release:

```sh
bun run --cwd apps/desktop test:preview-snapshot:electron
# Or reuse an installed binary matching apps/desktop/package.json exactly:
bun run --cwd apps/desktop test:preview-snapshot:electron --executable=/path/to/Electron
```

## Settings and initialization diagnostics

Legacy global and per-instance OpenCode passwords now migrate into
`ServerSecretStore`. The settings document stores only references; client reads
redact the values. Updates preserve old redacted forms and roll back secret
mutations when publication fails. A deleted instance removes its password.
Missing references fail closed, while explicit replacement or removal can repair
them without silently discarding other credentials.

A separate failing-before regression reproduced private configuration values in
provider schema-error diagnostics and unavailable snapshots. Another reproduced
raw driver errors containing a credential in both outputs. Initialization now
reports only fixed configuration/initialization categories and public instance
identifiers. The focused settings and registry suites pass 38 tests, including
both leak cases, publication failure, reference recovery and client redaction.
These checks do not substitute for the failed native Electron fixture above.
