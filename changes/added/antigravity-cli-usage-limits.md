- Antigravity can show its 5-hour and weekly limits again. Turn on **Read limits with the
  Antigravity CLI** for an instance in Settings → Providers, and F5 runs the CLI's own `/usage`
  command for them. It's off by default, and F5 still never calls Google's quota APIs directly.
- When an Antigravity turn stops on an exhausted quota, the Limits card says so and shows when the
  quota resets, without asking Google anything. The card also no longer claims the installed
  Antigravity version can't report limits.
