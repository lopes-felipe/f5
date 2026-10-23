# Pi (early access)

F5 uses an existing Pi coding-agent installation through `pi --mode rpc`. Install Pi
0.80.5 or newer on the machine running the F5 server. For an npm installation:

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Run `pi` in a terminal, then `/login` to connect your model provider. On a headless
server, run it over SSH, open its authorization URL on your computer and paste the
redirect URL or authorization code into Pi if the callback cannot reach the server.
API keys can also be configured as sensitive environment variables on the instance.

In F5 Settings, add a Pi provider instance and refresh it. Existing installations do
not acquire a Pi instance automatically. Set the binary path if `pi` is outside the
server's PATH. Models use qualified `provider/model` identifiers so two providers'
models with the same name remain distinct. `Pi default` preserves Pi's configured
model and thinking level. Live workspace discovery supplies commands and skills.

Launch arguments can configure models, skills and trusted extensions. `--provider`
must be paired with `--model`. F5 rejects arguments that change RPC mode or choose
another session. Session-owned MCP credentials are supplied only to that session's
child process; background discovery and metadata prompts run without them, tools,
project extensions or persistent history. Isolated F5 profiles use their managed
home and explicit instance credentials, without inheriting another profile's Pi
configuration directory or model credentials.

Update Pi using `pi update --self`. F5's update action uses that same command and
retains the existing account, installation and active-session checks.

## Permissions and interaction

Supervised mode asks before commands, writes and extension tools. Verified native
read tools and the F5 catalog's annotated read tools continue without an approval.
Auto-accept edits also permits native edit and write tools. Full access permits
tool calls. Read-only workflows block mutations before those permission rules and
do not open a modal approval to grant a write. Changing that policy requires a
session restart. Pi does not expose F5's AI approval reviewer, so Auto is unavailable.
These tool policies do not sandbox trusted extension code outside a tool call.

Blocking confirmation, selection, input and editor dialogs appear in F5. Editor
prefills remain editable; clearing one sends an empty answer. Approvals expire with
their native request and cannot carry over into a replacement session. The F5 thread
catalog is exposed through the Pi extension with a single `mcp__f5__` namespace.

Text and reasoning stream separately; final native messages supply missing deltas.
Tool results retain bounded structured output and native shell exit codes. At most
one supported image per completed tool result becomes an authenticated, thread-owned
attachment; unsupported or excess images are counted. Inline image bytes are removed
before runtime events enter the queue. Up to ten prompt images fit within the bounded
8 MiB inline image budget; other attachments are supplied as local file context.

F5 resumes Pi's persisted session file. Conversation rollback forks before a captured
native user entry, persists the adopted session identity before hydration and verifies
the retained branch. An uncertain result blocks new prompts and is never replayed
blindly. Assistant-only extension turns retain their own history boundary. They can
be retained when rewinding a later user turn, but Pi cannot fork directly before an
assistant-only turn. Conversation rollback does not restore files.

Extension wakes retain their exact native owner while F5 admits a continuation
through the normal queue. Admission waits up to ten seconds for the previous F5
turn to settle. A paused thread, queued user message, pending question, disabled
provider or stale session rejects the wake and closes its child. Admission replays
buffered events without sending another prompt; a lost owner is never resumed as
a new prompt. Buffers and concurrent admission are bounded.

## Current integration limits

Title generation uses the thread's five most recent saved PR links when available.
Reference labels are bounded and supplied as quoted, untrusted context alongside
the user's request. This reads the local projection without probing a forge account.
Missing or invalid link data leaves ordinary title generation available.

The full October catch-up remains in progress. Pi computer automation and native
history import are unavailable. Verified in-session rewinds now reconcile captured
host turns against Pi's active ancestry. Unlocated turns and other providers remain;
queued prompts pause for review, and late writes cannot recreate retired turns.
Reconciliation needs the same idle native session before and after acknowledgement.
Unexpected native session switches, incomplete ancestry or unconfirmed projection
still block new prompts. The integration is tested against a scripted Pi RPC
process; validation with a real Pi account is still pending, so Pi stays in early
access.
