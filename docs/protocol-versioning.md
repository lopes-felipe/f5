# Client/server protocol compatibility

> Contributors: when and how to bump the client/server protocol version.

`F5_PROTOCOL_VERSION` in `packages/contracts/src/protocol.ts` is the exact wire
version shared by the bundled server, desktop renderer, and web client. It starts
at 1. Increment it when adding a union variant or state shape that a client must
decode, including attachments, questions, rewind, steering, stream resync, and
worktree setup. This gate does not change persistence formats or restrict reading
existing data.

WebSocket clients include `?protocol=<version>` on every connection and reconnect.
Authentication and origin checks still run first. A missing, repeated, malformed,
or different version closes with code 4426 and the JSON reason
`{"error":"upgrade-required","protocolVersion":1}`. Rejected sockets never enter
the application's connection handler: they receive no welcome, snapshot, domain
event, or RPC response, and their queued mutations cannot execute.

Private HTTP mutations send `X-F5-Protocol`. A mismatch returns HTTP 426 with the
same JSON object and `Cache-Control: no-store`, before any upload is processed.
GET/HEAD requests and authentication bootstrap are exempt. The CORS preflight
allowlist includes the protocol header. Backup restore, the current HTTP upload
path, uses the shared `protocolFetch` helper; future attachment uploads must do so
as well (or carry the same header and handle 426 in their XHR implementation).
Upload callers acquire `beginProtocolUpload()` before sending and release its
lease in `finally`, after consuming the response.

Each harness release bumps the version once: Release 1 is 16, and Release 2 is 17
(session capability snapshots, reported model capabilities, catalog sources and the
provider inventory RPC).

Worktree safety Release 1 uses version 23 (the preceding version was 22). It adds
`worktrees.inspect`, `worktrees.remove`, `worktrees.threadState`, and `worktrees.recover`,
removes public force removal, and preserves filesystem paths without trimming. Thread state
also reports whether recovery is running or interrupted so a retained recovery barrier stays actionable.
`worktrees.recover` accepts `cancel` to stop active preparation while retaining the barrier for explicit retry.

Worktree creation Release 2 uses version 24. Setup snapshots and subscribe/action/push envelopes
carry a persisted `(generation, sequence)` ordering. Setup mutation requests require the expected
operation ID. Bootstrap preparation accepts explicit naming intent and a setup-script override;
raw preparation accepts an acknowledgment for retrying interrupted scripts.

Worktree switching Release 3 uses version 25. It adds `worktrees.switchWorkspace`,
`worktrees.getTransition`, `worktrees.previewTransitionRecovery`, and
`worktrees.resolveTransition`, plus derived `workspace_switch` / `workspace_switch_failed`
queue reasons and transition snapshots. Raw checkout accepts conversation context;
initial attachment accepts explicit shared-filesystem confirmation. Recovery delegates to
transitions. Recovery can also accept the inspected project checkout when recreation left no
checkout to adopt. Workspace isolation failures have a stable error code. An active transition
is independent of queue pauses and cannot be cleared by resume.

October upstream ports use version 29 (main already includes protocol versions
26–28 for worktree management, MCP and storage). Git commit results gain `context_changed`
and retain a suggested message for inspection when HEAD, staging, or included
content changes during generation. No commit, push or PR creation follows that result.
This is the single protocol bump for this bundled catch-up release.

The authenticated `GET /api/bootstrap` response and WebSocket welcome advertise
current capabilities, upload support, and global send limits. Today
image attachments retain the existing eight-image, 10 MiB/image and 120,000-character
limits. Generic attachment uploads are explicitly disabled; future-phase limits
are not advertised early. The composer obtains limits from this metadata for image
imports, compression, and text validation. Persisted drafts remain readable without
metadata; importing or sending new content requires the server limits.

On 4426 or HTTP 426, the web client stops reconnecting and sending mutations and
shows “F5 was updated. Reload to continue.” The workspace remains mounted. Reload
is scheduled after active uploads finish, including reading their responses, and
new uploads are refused. Send remains disabled until welcome limits arrive; a welcome
without metadata is explicitly rejected. Automatic reload waits for imports and
verified draft persistence, and is attempted only once per client version in a tab.
If saving fails, users can download a JSON recovery copy containing draft text and
image data URLs. A warned "Reload anyway" action remains available during uploads.
Provider-specific limits will be introduced alongside provider-specific enforcement. The upgrade
surface is always enabled, independently of the optional disconnect overlay.
Both direct `index.html` requests and SPA fallback responses use `no-cache` so a
reload fetches current assets.

The first introduction of this protocol cannot retrofit reload handling into a
previously loaded pre-versioning client. Such a tab is safely rejected but requires
one manual reload. Clients shipping this version handle subsequent version bumps
automatically. This PR does not introduce a durable protocol minimum or a second
protocol family.

This implements the Phase 0c prerequisite. Phase 0b's full 1,836-SHA classification
remains outstanding; the existing frozen ledger is unchanged. No upstream commit
is marked ported for this f5-specific compatibility infrastructure.

Worktree management Release 4 uses version 26. It adds `worktrees.list`, returning
project-scoped inventory, checkout classification, missing/status information, and linked
conversations. Inventory is informational; existing removal and transition methods recheck
identity, ownership, and claims before mutating anything.

Storage scan contract uses version 27: `storage.getUsage` returns immediately with
`report`, `confirmation`, and `status`; profile-wide `storage.statusUpdated` carries scan progress.
Storage operation contract uses version 28: cleanup accepts a backend epoch and returns
an accepted operation; results survive socket disconnects, and `storage.getOperation`
and `storage.getTargets` page retained details. Versions 25 through 27 are rejected by
the version 28 server before any queued mutation can execute.

Worktree move Release 5 uses version 29. It adds `worktrees.moveThread` and
`worktrees.discardMovedChanges`, the `move_to_new_worktree` transition intent, and
optional move summaries on transition snapshots. Private move snapshots and cleanup
progress extend the existing transition JSON record with optional fields, so older
persisted transitions remain readable. An additive partial index bounds startup recovery
to unfinished moves and pending private-ref cleanup.

The October catch-up integrated with worktree move Release 5 uses version 30.
It retains version 29's move methods alongside the October provider/settings
contracts. Clients from either earlier branch must reload against this combined
server before issuing mutations.

Upstream Ports uses version 40. It adds the `upstreamPorts.*` methods (`listProjects`,
`getOverview`, `listTopics`, `getTopic`, `decide`, `acceptSuggestions`, `run`, `startPort`,
`unlinkPort`, `getPortPrompt`, `resolvePublication`, `addRemote`, `takeOverWriter`) and the
`upstreamPorts.changed` push channel, which carries invalidation only. Older clients have no
Upstream page, so the bump only forces them to reload before calling the new methods.
