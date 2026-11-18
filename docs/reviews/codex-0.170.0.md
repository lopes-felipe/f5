# Codex 0.170.0 integration

F5 bundles **@openai/codex 0.170.0**, released November 18, 2026. Source revision:
**29eb79e9866b3262a777fdf8195c1b9e63684c91**. The previous baseline was 0.166.0.
The [official changelog](https://learn.chatgpt.com/docs/changelog) describes the
intervening releases; the [app-server reference](https://learn.chatgpt.com/docs/app-server)
describes the client interface.

## Integration matrix

| Addition or change                                                                | F5 disposition                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native model provider listing/configuration                                       | Provider settings list native providers and edit custom gateways, Bedrock and Vertex AI using native APIs. Managed fields remain protected.                                                                                                        |
| Provider-specific model catalogs                                                  | Explicit provider-scoped discovery; configuration changes invalidate the instance catalog. Saved conversation cursors retain the native provider, and resumed legacy cursors refresh their catalog from the effective native provider.             |
| Gateway browser/device authorization                                              | An instance-owned control connection retains handoffs and completion notifications. Device flows match login IDs. Cancellation retires the connection to fence browser events without IDs.                                                         |
| Account security setup                                                            | Read-only, account-keyed notices in Profiles & Accounts and provider settings. Links require a click. Unsupported or unavailable reminders do not block configuration.                                                                             |
| Required human command checkpoints                                                | Advertise support on 0.170.0+. Fresh one-time approval, decline or cancellation only; session/persistent allowances cannot answer them.                                                                                                            |
| Moderated answer presentation                                                     | Apply native show/hide/block decisions to message completion, snapshots and child transcripts. Replace provisional message projections when needed.                                                                                                |
| Assistant contentTokenCount                                                       | Retained as optional native item telemetry, separate from aggregate token usage and cost.                                                                                                                                                          |
| MCP resource targeting                                                            | Preserve originating call and explicit connector/link identity in captured app references and reference equality. UI reads identify the authorized attachment; routing comes from its persisted reference, not browser-supplied account overrides. |
| Audio attachments and audio file IDs                                              | Opt-in local recordings use native localAudio, once per turn, only with reported audio input support. Hosted file-ID uploads are not introduced.                                                                                                   |
| Animated image generation                                                         | Opt-in native feature flag; existing bounded generated-image storage preserves GIF bytes and deduplicates late output.                                                                                                                             |
| Thread section notifications                                                      | Classified state-only. F5 owns conversation organization.                                                                                                                                                                                          |
| OAuth cancellation/login/logout races                                             | Inherit runtime fixes; F5 gateway cancellation and account changes fence pending login state.                                                                                                                                                      |
| Cloud recovery, oversized request fallback, permission inheritance, Windows fixes | Inherit runtime behavior; retain F5 lifecycle and operation reservations.                                                                                                                                                                          |
| Refreshed OpenTelemetry exporter credentials                                      | Inherit runtime capability. F5 retains its existing telemetry configuration.                                                                                                                                                                       |
| Environment-scoped duplicate MCP names                                            | No opt-in exposed. F5 does not flatten multiple execution environments into its single server-name routing model.                                                                                                                                  |
| Terminal workspace tabs, task search, backend picker, image previews              | Terminal-only presentation. F5 retains its navigation, search, attachment previews and aside workflow.                                                                                                                                             |
| Vertex AI setup wizard and incremental tool streaming                             | Cloud fields are editable in F5; execution/streaming improvements come from the runtime. No terminal wizard is embedded.                                                                                                                           |
| agents.enabled replaces explicit features.multi_agent                             | F5 does not write the deprecated flag. Existing operator configuration remains native-owned.                                                                                                                                                       |
| WebRTC voice negotiation                                                          | TUI runtime capability; no F5 calling UI or media transport introduced.                                                                                                                                                                            |
| Remote transports, native projects/queues and desktop-only integrations           | Existing ownership and certification gates remain. No remote listener or additional native plugin is enabled.                                                                                                                                      |

## Compatibility and settings

Wire protocol **45** adds the Codex configuration RPC and model modality metadata.
Native-provider selection lives in the server-owned Codex instance configuration;
its launch arguments form part of the existing launch identity and catalog lifetime.
Changing the default does not migrate saved conversations.

Custom executable paths remain supported. The minimum isolated runtime remains
0.144.3, and existing 0.159.2/0.162.0/0.166.0 feature gates remain intact. New
configuration, audio and human-checkpoint capabilities require 0.170.0.

Experimental media defaults to disabled. Native configuration stores animation at
**features.image_generation_animation** and the F5 audio preference in Codex's
extensible **desktop.f5_audio_attachments** map. Audio is checked before dispatch.
Ordinary audio files retain their attachment paths when native audio is disabled
or unavailable, and tools can still access those paths when native audio is used.
Media changes apply to new sessions. Gateway OAuth is explicit: session processes
do not automatically open a browser on the server host.

Protocol audits check nested request keys, including approval capabilities and
provider authentication fields, against the generated experimental schemas.
The exact binary's approval-kind schema includes `humanCommand`; server-side
one-time-only decisions are covered by protocol fixtures. A live policy-triggered
human checkpoint has not been certified.
Animation changes apply when the native session next loads its configuration.
Credentials remain in existing sensitive environment storage or native credential
files; provider forms expose variable names and server-side paths.

The exact release's generated **experimental** fork schema supports exclusive
**beforeTurnId**, including the empty prefix before the first turn. The stable schema
omits this experimental field. F5 deliberately retains the valid experimental
request and its history read-back validation. Request audits now reject excess
top-level properties rather than relying solely on structural assignments.
This exposed and removed the unsupported fork-only goal deferral field from
resume requests. F5's existing coordinator still pauses unowned active goals.

## Verification

- Generated stable and experimental TypeScript and JSON schemas from the bundled
  binary; committed their audited checksums. Both protocol and request audits are
  required before release.
- Native, isolated, credential-free configuration test verifies gateway creation,
  partial edits, both media opt-ins, and saved provider identity after changing the
  default and reopening a separate process with another explicit provider.
- Authenticated isolated Release 4/5 spikes passed fork and attachment metadata,
  goal lifecycle, compaction, inline review, side questions, memory and read marks.
- Authenticated 0.170.0 rewind certification passed retained-history validation
  and a follow-up turn, using the available catalog model (gpt-6.2-sol).
- Authenticated computer MCP transport test passed against a simulated host that
  never emits OS input. The browser-resume/MCP reload protocol smoke also passed.
- Browser tests cover provider edits, default restrictions, binding selection and
  disabled experimental opt-ins. Unit tests cover human checkpoints, moderation
  replacement, audio admission, OAuth correlation and preserved GIF bytes.

These results do **not** certify native Chrome extension/OS interaction or
Linux/Windows release artifacts on 0.170.0. No native integration certification
record was stamped from simulated-host or protocol-only evidence.
Gateway OAuth correlation uses synthetic notifications in tests. Actual external
gateway identity providers and Bedrock/Vertex model calls require operator accounts.
