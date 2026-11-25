- Codex hooks that need approval after a plugin changed are marked "Needs approval" in Settings →
  Providers → Hooks, plugins and connectors, with Trust and Trust all buttons that approve the
  contents shown, through Codex. Hooks that changed again before you confirm are not trusted. If
  Codex cannot save the approval (for example because `config.toml` breaks an administrator
  requirement), its error appears next to the hooks. Conversations that are already running pick
  up the approval when their Codex session restarts.
- A turn's "hook approval required" failures now show as one warning row naming the changed
  plugins, with a link to review those hooks for the conversation's provider and project, instead
  of one red card per hook.
