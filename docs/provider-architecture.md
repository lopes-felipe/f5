# Provider architecture

> Contributors: the WebSocket protocol between web and server, and the provider adapter contract.

The web app communicates with the server via WebSocket. Requests and pushes are expressed as tagged discriminated unions rather than plain JSON-RPC:

- **Request/Response**: `WebSocketRequest` → `WebSocketResponse` (both carry a `_tag`). See `packages/contracts/src/ws.ts`.
- **Push events**: first-class `WsPush` channels with monotonic `sequence` per connection and channel-specific `data`.

Push channels include `server.welcome`, `server.configUpdated`, `terminal.event`, `orchestration.domainEvent`, and `git.actionProgress`. The full list lives in `packages/contracts/src/ws.ts`. Payloads are schema-validated at the transport boundary (`wsTransport.ts`). Decode failures produce structured `WsDecodeDiagnostic` entries with `code`, `reason`, and path info.

Methods mirror the `NativeApi` interface (`packages/contracts/src/ipc.ts`; `@t3tools/contracts` is a legacy package name, see [NOTICE.md](../NOTICE.md)), grouped by namespace. Examples:

- `orchestration.dispatchCommand`, `orchestration.getStartupSnapshot`, `orchestration.getTurnDiff`
- `nextTurnQueue.submit`, `nextTurnQueue.setPaused`
- `terminal.*`, `git.*`
- `server.getConfig`, `shell.openInEditor`

## Supported providers

Every provider implements the shared `ProviderAdapter` contract (`apps/server/src/provider/Services/ProviderAdapter.ts`), so orchestration, checkpointing, projections and workflows stay provider-agnostic. Adapters live in `apps/server/src/provider/Layers/`:

- **Codex:** `CodexAdapter.ts` launches `codex app-server` per session and speaks JSON-RPC over stdio.
- **Claude Code:** `ClaudeAdapter.ts` runs sessions through `@anthropic-ai/claude-agent-sdk` and normalizes its SDK events into the shared orchestration event shapes.
- **Cursor:** `CursorAdapter.ts` speaks the Agent Client Protocol (ACP) to `agent acp`.
- **OpenCode:** `OpenCodeAdapter.ts` talks to a local `opencode serve` process or an external OpenCode server.
- **Grok and Antigravity:** `GrokAdapter.ts` serves both over ACP.
- **Muse Code:** `MuseAdapter.ts` speaks the Muse Session Protocol (MSP) to `muse serve` through `@muse-code/sdk`.

Each adapter is constructed by a driver in `apps/server/src/provider/Drivers/*Driver.ts`, and every built-in driver is listed in `apps/server/src/provider/builtInDrivers.ts`. `ProviderAdapterRegistry.ts` is a lookup facade over the live instance registry, so settings changes and custom instances are visible without rebuilding the server layer, and `ProviderService.ts` routes sessions and turns to the right adapter. To add a provider, implement the `ProviderAdapter` contract, wrap it in a `ProviderDriver` and add that driver to `builtInDrivers.ts`.

## Client transport

`wsTransport.ts` tracks connection phases `connecting`, `connected`, `reconnecting` and `disconnected` (`apps/web/src/wsConnectionState.ts`). Read-only requests work in any phase. Mutating requests fail with a retryable `ConnectionNotReady` error until the socket is connected and synchronized; stop and answer requests skip the synchronization wait. Drafts are kept, and a reconnect never re-sends a change on its own. Inbound pushes are decoded and validated at the boundary, then cached per channel. Subscribers can opt into `replayLatest` to receive the last push on subscribe.

## Server-side orchestration layers

Provider runtime events flow through queue-based workers:

1. **ProviderRuntimeIngestion** — consumes provider runtime streams, emits orchestration commands.
2. **ProviderCommandReactor** — reacts to orchestration intent events, dispatches provider calls.
3. **CheckpointReactor** — captures git checkpoints on turn start/complete, publishes runtime receipts.

4. **NativeSessionCleanupReactor**: on `thread.deleted`, removes the thread's native
   transcript from the bound instance's own store, unless another live thread binds the
   same session.

All four use `DrainableWorker` internally and expose `drain()` for deterministic test synchronization.

## Capabilities

There are three layers, each with its own owner:

- **Executable**: `providerRuntimeCapabilities(driver, version)` in
  `@t3tools/shared/providerRuntimeCapabilities` describes what an adapter and CLI
  version can do. New flags decode to `false` when an older peer omits them.
- **Session**: `ProviderService.getSessionCapabilities(threadId)` returns a snapshot of
  one session generation. It is routed through the persisted binding and never starts a
  session. The snapshot holds the generation, the instance, the executable version, the
  discovery outcome, and per-action support with a structured `unavailableReason`. It is
  projected onto `thread.session.capabilities` and refreshed when the native command
  catalog arrives. The generation is persisted in the binding's runtime payload: it is
  incremented on start and resume, and kept when an existing session is adopted.
  `assertSessionAction` re-checks the generation, executable support and policy before an
  action is routed, and refuses a stale browser with `stale-generation`. The browser
  sends `expectedSessionGeneration` with steer (direct and queued) and with conversation
  rewind. An older or out-of-order snapshot never replaces a newer projected one.
  `getCapabilities(provider)` remains for adapter-wide facts.
- **Model**: `resolveModelCapabilities(provider, slug, reported?)` in
  `@t3tools/shared/model` merges executable-reported capabilities over F5's built-ins.
  Both the composer and the launch path use it.

Instances may also expose `inventory` (read-only hooks, plugins, connectors and agents,
served by `server.getProviderInventory`) and `deleteNativeSession`.

## Transport framing and delivery outcomes

Codex and ACP use the shared incremental UTF-8/CRLF line framer. It preserves
empty lines, split code points and final unterminated lines. ACP retains its
16 MiB frame limit and fails its transport on decode/framing failure, settling
pending requests. Codex session stdout has no new frame ceiling: large history
responses remain valid. A malformed session line produces a protocol error event
and leaves the session alive. Codex stderr is framed incrementally and can carry
a truncation marker on unusually long diagnostic lines.

The Codex stdin writer tracks queued admission separately from physical writes.
Expired or cancelled queued entries are removed before `stdin.write`; they fail
as `not_sent`. Once writing has begun, timeout/abort is an `unknown` outcome and
cannot authorize an automatic resend. Interrupts and approval/input replies have
reserved admission and run after the active physical write. Delivery certainty
and retryability survive adapter/service wrapping into the durable delivery result.

Exit/error settles pending Codex RPCs immediately, including replaced contexts.
Notification sources drain to EOF or the shutdown budget and retain the originating
session generation. Per-generation FIFO preparation orders native logging, mapping,
image preparation and publication; completion cannot overtake earlier output.
Version probes are asynchronous, share only concurrent checks of the same resolved
executable identity/environment, and cancel the child when their last waiter exits.
MSP child exit closes its incoming channel immediately, settling in-flight SDK
requests. Close waits for child exit with bounded escalation, removes its timeout
waiters, and observes the application deadline when shutting down. The spawned-host
fixture verifies request failure after exit and forced termination.

ACP malformed input is fatal to the transport: pending requests reject, and a
FIFO termination notification reaches the adapter after prior notifications.
Cursor, Grok and Antigravity publish one runtime error and one session exit,
retire the matching context and close its scope from a sibling fiber. A stale
context cannot close its replacement. Their spawned-agent tests cover both malformed
JSON and child exit, request settlement within one second, repeated disposal and
confirmed child termination. The POSIX OpenCode process-group fixture also verifies
that shutdown reaps an owned server and its descendant when both ignore TERM;
Windows keeps its separate descendant teardown path.

Claude completion records carry exact emitted block text in `payload.data.text`,
including leading newlines and trailing whitespace; display detail is not the recovery
source. Ingestion can restore a missing suffix from that text. Claude delta coalescing
remains disabled until its server-crash/transcript-resume test passes and the C0
comparison meets the proposed latency/queue criteria.

OpenCode SDK fetches share an owning-session abort signal, installed before
`session.create`. An owned server exit aborts pending HTTP requests immediately;
the adapter emits one runtime error followed by one exit and closes the session
from its adapter scope, avoiding a fiber waiting for its own scope to close.
Remote tree cleanup and process escalation respect the shared shutdown deadline.

The killed-server Claude gate (`integration/chaos/claudeRecoveryGate.integration.test.ts`)
retains complete native transcript text across restart but observes partial, empty
runtime history after resume. Claude coalescing remains disabled. The shared SDK
query fake exercises F5 recovery; live CLI compatibility remains separate.

ACP native log records classify `session/update` by its update subtype. Message
and thought chunks batch without delaying delivery; plans, tool updates, turn
boundaries and unknown updates await append completion. Intentional PTY restarts,
working-directory/environment replacements and shutdown drain their source without
publishing a tab-closing `exited` event. Natural exits still publish it.
