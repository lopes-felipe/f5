# Bring projects from Codex and Claude

The welcome screen keeps F5's display-profile selection and harness validation.
Use **Set up agents** to configure providers, then **Discover projects from agent
history** to inspect projects in this server profile's configured Codex and Claude
homes. Scanning starts only when clicked and does not modify the CLI files.

Select projects to add. Existing projects are reused. **Also import recent thread
history** is off initially; selecting it imports sessions modified in the last 30
days, retaining the first prompt and up to 199 recent messages per thread. Discovery
and import are bounded and report when limits are reached. Tool output is omitted.

Imported threads remain stopped until you send a message. Continuing resumes the
original CLI session using its configured provider instance and F5's approval
defaults. Importing never copies credentials, enables providers, changes branches,
or creates worktrees. Retrying an import preserves threads already imported.

If a CLI changes a transcript after discovery, scan again before retrying. Isolated
profiles scan only their configured homes; configure the intended agent home in
Providers settings before discovery.
