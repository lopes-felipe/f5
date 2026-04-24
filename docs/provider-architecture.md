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

All three use `DrainableWorker` internally and expose `drain()` for deterministic test synchronization.
