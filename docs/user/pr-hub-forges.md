# PR Hub accounts and forges

PR Hub supports GitHub (including configured Enterprise hosts), GitLab, Bitbucket Cloud, Azure DevOps, and Forgejo/Gitea. Thread Git actions and the hub use the same typed forge adapters. All support reading diffs. Only GitHub exposes native stacks; hosts returning 404 or 422 hide that section.

Use **Manage accounts** in Pull requests to verify a token with its provider host. Azure DevOps PAT verification also requires an organization. Tokens live in the profile's server secret store, separately for each host, verified login, and credential generation. They are never returned to the browser. Account metadata and exact repository routes live in SQLite. Select the legacy profile account to retain the existing GitHub setup; this remains the default.

A repository route binds provider, host, and repository to one verified account. With one matching account, routing can select it automatically. With several matching accounts, configure an explicit route. Selecting an account does not change a process-global active credential. Replacing credentials invalidates that account's runtime and caches. Monitoring and request budgets belong to the server and account, rather than to an open browser panel.

The hub displays only advertised actions. Permissions can further narrow GitHub actions. GitLab supports comments and approval, with rebase updates. Bitbucket supports comments, approval, and change requests, but no branch updates or reactions. Azure has no comment/review writes or branch updates and supports merge/squash. Forgejo supports comments and review verdicts, merge/rebase updates, and no review-thread reply/resolve or draft conversion. Native reviewer and label identifiers are preserved where a provider requires IDs.

Forge controls first prepare an immutable operation, showing its account and pinned revision. Confirmation dispatches it once. Prepared operations can be canceled. Reloading restores the saved operation. If a response is lost, **Check saved operation** looks for verified host evidence; it never blindly sends the mutation again. An unresolved operation blocks preparing another mutation for that pull request. GitLab/Bitbucket reviews persist their comment and verdict as separate phases, so a recovered comment cannot be mistaken for an accepted verdict. Stack actions verify layer revisions and preserve partial progress.

Viewed marks use the reader and compared head/base revision. GitHub stores them on the host; the other forges store them in F5. A changed revision does not inherit an old mark. Cached data stays visible with a stale warning when refresh fails. Reads, pagination, and account runtimes are bounded.

PR markdown renders authenticated GitHub images and videos through the media proxy. Its allowlist permits GitHub user attachments, GitHubusercontent hosts, and configured Enterprise hosts. Tokens go only to their own host, including through redirects. Images/videos have a 100 MB limit and support single byte ranges. Arbitrary HTML is escaped.

Hover a PR link to preview it, copy it, or open it in the hub. A thread can link several pull requests, including different providers; links use provider/host/repository/number identity and the existing additive projection. **Send to agent** places a diff comment in the linked F5 thread's composer and preserves existing draft text. It does not send a turn automatically.

This phase adds SQLite migration 102 for account routing, native snapshots, revision-specific viewed marks, and durable forge operations. WebSocket protocol 14 requires matching clients and servers. The web-local selected account is stored through the app settings schema; shared client settings do not acquire browser persistence fields.
