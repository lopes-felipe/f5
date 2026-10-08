# Provider architecture

The web app communicates with the server via WebSocket. Requests and pushes are expressed as tagged discriminated unions rather than plain JSON-RPC:

- **Request/Response**: `WebSocketRequest` → `WebSocketResponse` (both carry a `_tag`). See `packages/contracts/src/ws.ts`.
- **Push events**: first-class `WsPush` channels with monotonic `sequence` per connection and channel-specific `data`.

Push channels include `server.welcome`, `server.configUpdated`, `terminal.event`, `orchestration.domainEvent`, and `git.actionProgress`. The full list lives in `packages/contracts/src/ws.ts`. Payloads are schema-validated at the transport boundary (`wsTransport.ts`). Decode failures produce structured `WsDecodeDiagnostic` entries with `code`, `reason`, and path info.

Methods mirror the `NativeApi` interface defined in `@t3tools/contracts` (legacy package name; see [NOTICE.md](../NOTICE.md)):

- `providers.startSession`, `providers.sendTurn`, `providers.interruptTurn`
- `providers.respondToRequest`, `providers.stopSession`
- `shell.openInEditor`, `server.getConfig`

## Supported providers

Both providers implement the shared `ProviderAdapter` contract (`apps/server/src/provider/Services/ProviderAdapter.ts`) so the rest of the server — orchestration, checkpointing, projections, workflows — stays provider-agnostic.

- **Codex** — `apps/server/src/provider/Layers/CodexAdapter.ts` launches `codex app-server` per session and speaks JSON-RPC over stdio.
- **Claude Code** — launched through the `@anthropic-ai/claude-agent-sdk`; the adapter normalizes its SDK events into the same orchestration event shapes that the Codex adapter emits.

Additional providers can be added by implementing the `ProviderAdapter` contract and wiring them into `ProviderService`.

## Client transport

`wsTransport.ts` manages connection state: `connecting` → `open` → `reconnecting` → `closed` → `disposed`. Outbound requests are queued while disconnected and flushed on reconnect. Inbound pushes are decoded and validated at the boundary, then cached per channel. Subscribers can opt into `replayLatest` to receive the last push on subscribe.

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
  action is routed, and refuses a stale browser with `stale-generation`.
  `getCapabilities(provider)` remains for adapter-wide facts.
- **Model**: `resolveModelCapabilities(provider, slug, reported?)` in
  `@t3tools/shared/model` merges executable-reported capabilities over F5's built-ins.
  Both the composer and the launch path use it.

Instances may also expose `inventory` (read-only hooks, plugins, connectors and agents,
served by `server.getProviderInventory`) and `deleteNativeSession`.
