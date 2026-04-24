# Runtime modes

F5 exposes a global runtime mode switch in the chat toolbar. The mode selects the approval/sandbox posture of new provider sessions and is honored by both the Codex and Claude Code adapters:

- **Full access** (default): starts sessions with the provider's permissive posture. For Codex this maps to `approvalPolicy: never` + `sandboxMode: danger-full-access`; for Claude Code it maps to `permissionMode: bypassPermissions`.
- **Supervised**: starts sessions with the provider's approval-gated posture and prompts in-app for command/file approvals. For Codex this maps to `approvalPolicy: on-request` + `sandboxMode: workspace-write`; for Claude Code it maps to `permissionMode: default`.

The chosen mode is persisted alongside the thread/session so reconnects and resumes keep the same posture. See [provider-architecture.md](./provider-architecture.md) for how the shared adapter contract surfaces this.
