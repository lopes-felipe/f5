- New branches are named `<prefix>/<type>/<slug>` (for example `f5/fix/login-redirect`), using the
  Branch prefix setting or `f5` when it is empty. A new thread starts on a readable
  `<prefix>/wip/<slug>` placeholder taken from its first message instead of `t3code/<hex>`, and
  F5 gives it its final name before the first push. Pull request checkouts use
  `<prefix>/pr-<n>/<head>`; existing `t3code/...` branches keep working.
