# Antigravity

Antigravity is disabled by default. Add or enable its provider instance in Settings,
choose **Install Antigravity**, then **Sign in** and follow the Google link. Installation
is explicit: status checks and thread starts never download software or open a browser.

F5 pins the official `agy_acp_server_1.1.1` release. It streams the archive into a staging
directory, verifies its SHA-256 and exact size, extracts only the two pinned executables,
and publishes the completed installation atomically. Interrupted installations do not
become available. A damaged existing installation produces an error naming the managed
release directory rather than overwriting it. The supported assets are macOS arm64,
Linux x64/arm64, and Windows x64/arm64.

Google personal OAuth credentials belong to one F5 profile and provider instance.
They survive server restarts and are not imported from another profile or the ambient
Google environment. Account setup uses F5's existing owner-bound jobs and installation-wide
OAuth lease. Changing accounts requires stopping active turns; idle runtimes are stopped
before account changes so they do not retain the previous credentials. New sessions, turns,
compaction and metadata generation are rejected until the account job exits. Installation
uses a separate profile lock, so downloading the release does not block other sign-ins.

The composer uses the model choices advertised by the running agent. Until the first
session supplies that inventory, **Antigravity Default** uses the agent's account default.
Explicit custom model names remain available. Native slash commands, reasoning text,
questions, file/tool approvals and form elicitation use the existing F5 thread UI.
Optional form fields may be skipped, including on entirely optional forms. Unsupported
forms are cancelled rather than approving fields the user cannot see.
Permission buttons show only native choices, including native persistence warnings.

Native `/compact` is off by default and must be enabled in the instance settings.
F5's existing compaction remains the default. Antigravity supports approval-required and
full-access modes; it does not advertise read-only workflow enforcement. Questions still
require an answer in full-access mode. Message-mode asynchronous questions and durable
answer attachments remain part of Phase 8.

The current image-only attachment path enforces the existing per-image limit and an
additional 50 MiB total per Antigravity turn. Generic file uploads and their advertised
per-provider limits arrive in Phase 7. Subagent launch receipts remain running work until
the parent turn finishes; the UI does not claim that a successful launch means every
subagent completed.

Provider status checks only inspect local installation/account files. Each live process
gets a scoped temporary directory, removed after shutdown. Only user skill directories
are linked from `~/.gemini/config/skills` and `~/.gemini/antigravity-cli/skills`; credentials,
hooks and MCP configuration are not shared this way. The same two directories in the
instance's home form its private skill catalog. The CLI publishes no catalog of its own,
so F5 scans them on each status check.

The browser helper alone sets `ELECTRON_RUN_AS_NODE`. Agent tool commands retain Python
and Google Cloud tool configuration; Antigravity-specific authentication overrides are
removed, and the runtime explicitly uses the profile's personal OAuth account.
