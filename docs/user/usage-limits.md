# Usage and limits

Open `/usage?tab=activity` for F5 activity or `/usage?tab=limits` for account allowances. F5 remembers the last tab. Quota meters show remaining allowance and reset countdowns; unavailable credentials remain visible as unavailable. `/usage-limits` in the composer reads the cached snapshot without sending a turn or refreshing an account.

Account readers refresh every five minutes, including after failed reads. Refresh bypasses their caches. Disabled instances are not probed, and account homes stay isolated. F5 does not combine accounts on the basis of email or display name.

Codex's main allowance and Spark windows remain separate. Reset-credit updates preserve previously reported credits when a response omits the field. Using a reset credit opens a confirmation naming the account and allowance. Each instance permits one redemption at a time, with a 30-second deadline. Retry after an uncertain outcome reuses the original key, including after a page reload or server restart; a different key is blocked until that attempt is resolved.

Cursor uses dashboard percentages for a token or file-based login; API-key-only and macOS keychain-only credentials are unavailable. Grok supports its standard subscription login, while custom authentication deployments remain unavailable. OpenCode Go supports local API credentials; externally managed OpenCode servers own their own credentials and are not probed through the host account.

Antigravity quotas can be read through an explicitly configured CLIProxyAPI hub. In the Antigravity provider instance's server-owned environment, configure `F5_CLIPROXY_HUB_URL`, `F5_CLIPROXY_ACCOUNT_ID` (the exact auth-file ID), and `F5_CLIPROXY_API_KEY` (mark it sensitive). Optionally set `F5_ANTIGRAVITY_PROJECT` when the account needs a project. The hub substitutes its own account token for the provider request. F5 sends the management key only to the configured hub, refuses redirects, and does not select accounts by email. A custom quota gateway may instead supply `F5_CLIPROXY_USAGE_URL` returning `{windows: [{id, label, usedPercent, resetsAt}]}`. Without supported credentials, the instance shows unavailable quota.

Activity comes from durable usage facts emitted for completed F5 turns. Transcript cleanup does not remove these facts. F5 processes new events rather than rescanning transcript files, so external CLI activity is not inferred from unrelated account homes.

In **Usage prices**, enter USD per million tokens for an exact provider/model pair. Overrides apply only when the provider omitted cost and input/output token usage is known. Zero is valid; blank cache prices inherit the input price. Provider-reported costs, including zero, take precedence. Estimates are labeled; activity without a price stays explicitly unpriced.

# Claude resume compaction

SDK 0.3.280 provides the dialog and auto-compaction settings used here. In a Claude instance, enable **Prompt before compacting resumed sessions** to show the SDK's resume dialog as blocking pending input. The default is off. **Auto-compact window** accepts zero for the CLI default or 100,000–1,000,000 tokens. A shown resume dialog suppresses the adapter's duplicate compaction recommendation for that session. F5's CompactionService is unchanged.

# Automatic titles

The title generator returns a title and whether the user's intent still needs clarification. A generated title can refine after turns 1 and 3, with at most two durably recorded attempts. Context contains user messages, and late results must match the current title revision. A manual rename cancels pending generation and stops automatic refinement. Existing titles remain readable without title state. Database migrations 100 and 101 add title state and reset-credit request records; protocol version 13 prevents stale clients from receiving the new shapes.
