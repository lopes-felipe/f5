- Codex hooks that need approval after a plugin changed are marked "Needs approval" in Settings →
  Providers → Hooks, plugins and connectors, with Trust and Trust all buttons that approve their
  current contents through Codex. If Codex cannot save the approval (for example because
  `config.toml` breaks an administrator requirement), its error appears next to the hooks.
- A turn's "hook approval required" failures now show as one warning row naming the changed
  plugins, with a link to review the hooks, instead of one red card per hook.
