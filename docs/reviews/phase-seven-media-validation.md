# Phase 7 media and attachments validation

Implements Phase 7a (desktop backend-token allowlist, one capability-authenticated asset route, shared asset headers), 7b (HTTP uploads, generic file attachments, quotas, leases, provider delivery, paste folding) and 7c (rich file viewer, inline chat images, work-log image views). See [Attachments and media](../user/attachments-and-media.md) for user-facing behavior and limits.

Protocol version: **10**. Migration: **93** (`attachment_uploads`, `attachment_upload_claims`).

## Security boundaries

- The desktop sends its backend token only for requests from a registered F5 renderer's main frame whose origin equals the app origin. It fails closed when Electron omits `webContents` or `frame`. The desktop smoke test checks that an iframe `fetch`, an iframe `<img>`, a popup and a preview guest's top-level navigation receive no `Authorization` header.
- `/api/workspace-assets/<handle>[/<subpath>]` is capability-authenticated by a 192-bit handle (30-minute TTL, 2,048-entry LRU). `file` grants cover one path. `html-document` grants add passive css/image/font subresources in the document's directory (depth ≤ 4); js, mjs, json, html and dotfiles are refused.
- Reads use `lstat`, `O_NOFOLLOW`, dev/ino checks and realpath re-checks, and reject symlink segments. Tests cover symlink escape, an inode swapped during a read, TTL and eviction.
- `assetHttp` headers are shared by the asset route, `/attachments/*` and upload GET: `nosniff`, `no-referrer`, sandboxed CSP for HTML and SVG, single-range support (206/416), and `attachment` plus sandbox for everything else. A malicious HTML fixture's script, fetch, image beacon, `window.open` and form attempts are all blocked in Chromium.
- Active HTML runs only through **Open in preview browser**, on a separate loopback origin the token allowlist never authorizes.

## Uploads and delivery

- Byte and count limits, client/server concurrency (2/4, 429 with `Retry-After`) and staging quotas (1 GiB per draft, 2 GiB per profile, reserved before bytes are accepted, 507) are advertised through the bootstrap and re-checked on the server.
- Claims take a 10-minute lease and copy into thread staging with `COPYFILE_FICLONE`, never a hardlink. Tests cover one upload claimed by three threads with independent copies, a claim racing a release, draft renewal and expiry, and lease-versus-sweep.
- Claude, Codex and OpenCode receive up to 20 inline images; Cursor and Grok up to 10. Overflow images are delivered by path with a visible notice. Codex images use `localImage` paths. Non-image files are delivered by path, and OpenCode receives text/PDF `file://` parts. Antigravity is capped at 50 MiB per turn.
- HEIC stays a plain file. The libheif LGPL gate was not cleared, so no conversion dependency is added.

## Viewer and chat media

- The file viewer renders images (fit or actual size), Markdown (rendered or source, relative images resolved from the file's directory), sandboxed HTML (rendered or source), PDF, video and audio. Binary files get Download, plus Reveal on desktop. Breadcrumbs browse folders.
- Chat images: HTTPS images are off by default (`loadRemoteImagesInChat`) and load lazily without a referrer. Local paths use batched, re-issued asset grants with server-reported dimensions, so the slot keeps a stable size. Clicking an image opens a keyboard-navigable gallery that returns focus to its opener when closed.
- Work log: `image_view` entries show a collapsed thumbnail. Codex `imageView` items (`item.path`) and Claude `Read` calls on image files (including streamed input) carry their path through compaction and replay.
- A bare filename in an agent file link opens the single matching workspace file. It uses an exact match first, then a case-folded one, and never picks between ambiguous matches.

## Gates

Validation commands (macOS, Bun 1.3.11):

- `bun fmt`
- `bun lint` (10 existing warnings, no errors)
- `bun typecheck`
- `env -u F5_PROFILE_ISOLATED -u GIT_CONFIG_COUNT bun run test:full`
- `bun run --cwd apps/web test:browser`
- `bun run test:desktop-smoke`
- `F5_REQUIRE_UPSTREAM=1 bun run upstream-ports:check`

Results: the full workspace suite passed, and the exhaustive real-Git matrix passed **133 tests**. The browser suite passed **507 tests across 54 files**.

One full-load browser run hit a known render race in `GithubAccountPanel.browser.tsx` ("Disconnect" detached mid-click). That area is outside Phase 7; it passed 3/3 in isolation and in the next full run.

`test:desktop-smoke` passed on its final consecutive runs. Two earlier runs, made while other heavy suites had just finished, timed out waiting for the app to close after the double-tap quit step. An instrumented run showed both taps landing within 160 ms and the app closing normally. The authorization checks passed in every run.

## Performance

Interactive fixture, 5 warm-ups and 30 measured repetitions, merged Phase 6 (`e4d42fba36`) versus this branch:

| Measurement                        | Phase 6 p95 | Phase 7 p95 | Gate                          |
| ---------------------------------- | ----------- | ----------- | ----------------------------- |
| Composer input-to-paint            | 21.4 ms     | 19.0 ms     | ≤ 100 ms                      |
| Composer input while streaming     | 16.2 ms     | 16.1 ms     | ≤ 100 ms                      |
| Warm switch to the large thread    | 205.4 ms    | 190.4 ms    | ≤ 500 ms                      |
| Small-thread startup (wall)        | 166.5 ms    | 152.3 ms    | no regression > 10% and 20 ms |
| Small-thread startup (process CPU) | 440.3 ms    | 610.5 ms    | informational                 |

Two gates fail on **both** builds and are not introduced by this PR: `transport.pendingFrames` (4,148 / 2,000) and browser retained-heap growth ratio (9.3% baseline, 9.5% candidate, gate 5%; absolute growth passes at ~5 MiB / 10 MiB). Startup process CPU p95 rose while wall time fell; it has no stated gate, and this PR does not claim a performance improvement. No threshold is changed.

## PR review follow-up

Applied the review's eight findings and three notes. Each fix has regression coverage.

- **Upload preflight:** it now allows `X-F5-File-Name` and `X-F5-Upload-Client`. The allowlist and `Access-Control-Allow-Headers` come from one list.
- **Upload release:** a draft's uploads are released once the turn commits, either after bootstrap dispatch or after a settled queue submission. Failures before that keep the uploads so the restored draft can retry. A test sends a queued turn and checks that the staged bytes are gone.
- **Asset CORS:** capability asset URLs send CORS without credentials to the desktop and dev renderer origins, so text and Markdown previews can `fetch` them.
- **HTML preview CSP:** the passive-resource prefix uses the external request origin (Host plus TLS or forwarded scheme). A route test through `127.0.0.1` loads an allowed sibling stylesheet.
- **Asset URL batches:** issuance settles per file and returns `null` for unreadable entries, so one bad path no longer hides the whole batch.
- **Active previews:** they now carry a CSP that keeps scripts, `fetch`, images, frames and forms on the preview origin. The user guide documents the remaining navigation channel and the bearer nature of asset URLs.
- **Attachment caching:** `/attachments/*` responses are again cached as `private, max-age=31536000, immutable`.
- **Upload validation:** names are truncated at 255 UTF-16 units without splitting surrogate pairs, and declared MIME types over 100 characters fall back to `application/octet-stream`.
- **Minor notes:**
  - Ingress uses the server's shared upload service.
  - The single-operator ownership assumption is documented where uploads are created.
  - The inline-upload performance fixture is back to 8 × 1 MiB. It had grown to 100 MiB with the new attachment count.
  - The 20 MiB WebSocket cap already bounds inline data-URL sends before decoding, so that path needed no change.

CodeRabbit round: applied five inline comments and two nitpicks.

- Paste as text now takes precedence over file import.
- Sidebar drops show the same path-reference warnings as the composer.
- The upload queue survives a missing bootstrap.
- Synchronously throwing image conversions release their slot.
- Dropped folders are classified per transfer item.
- `imagePath` is part of the work-log dedupe signature.

The Markdown image comment was declined. It asked to restrict relative images to the document's own directory, which would break the common `../images/…` pattern. The identity root the server enforces is already the security boundary, and images load only from F5's own server.

After the fixes, format, lint, typecheck, the full suite and 133 real-Git tests all passed again. A run made during heavy unrelated machine load (load average about 280) timed out in 32 real-Git tests and two `MessagesTimeline` timing assertions. Both suites passed in full when rerun on their own. The server performance smoke run passed its upload gate (8 MiB decoded against a 80 MiB limit). It also reported `replay.pageEvents` 500 / 200; replay code is untouched by this PR.
